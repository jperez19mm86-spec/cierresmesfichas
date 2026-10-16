/* pase.js — LLEVA AL JUGADOR DE UN SITIO DEL CASINO A OTRO SIN QUE SE TENGA QUE LOGUEAR.
   Va pegado en los sitios viejos Y en los nuevos (ver src/pases.service.js). No muestra NADA salvo:
     · en el viejo, cuando se entra con ?pasar  → «Te estamos llevando…» y lo pasa;
     · en el nuevo, cuando llega con ?cw_pase=  → guarda la sesión y recarga.
   En cualquier otra visita no hace nada: no dibuja un chat, no toca el que ya está. */
(function () {
  'use strict';
  if (window.__lgPase) return; window.__lgPase = 1;
  var yo = document.currentScript && document.currentScript.src;
  var BASE = yo ? new URL(yo).origin : 'https://app.latamgames.online';
  var u; try { u = new URL(location.href); } catch (e) { return; }
  /* El sitio del casino LIMPIA la barra al arrancar (medido el 16-oct en ganamoschatt.com: entra con
     ?cw_pase=… y a los segundos queda «/»), y este script lo carga el propio sitio DESPUÉS de eso.
     Por eso se mira también el link con el que se abrió la página, que el navegador guarda tal cual. */
  var original = null;
  try { var nav = performance.getEntriesByType('navigation')[0]; if (nav && nav.name) original = new URL(nav.name); } catch (e) {}
  function param(k) {
    if (u.searchParams.has(k)) return u.searchParams.get(k);
    if (original && original.searchParams.has(k)) return original.searchParams.get(k);
    return null;
  }
  var pasar = param('pasar') !== null, codigo = param('cw_pase');
  if (!pasar && !codigo) return;

  // El parámetro se saca de la barra enseguida: que no quede en el historial ni se comparta.
  u.searchParams.delete('pasar'); u.searchParams.delete('cw_pase');
  var limpia = u.pathname + (u.search ? u.search : '') + u.hash;
  try { history.replaceState(history.state, '', limpia); } catch (e) {}

  function post(ruta, cuerpo) {
    return fetch(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
      .then(function (r) { return r.json(); });
  }

  var caja = null;
  function aviso(titulo, texto, girando) {
    function pintar() {
      if (!caja) {
        caja = document.createElement('div');
        caja.setAttribute('role', 'status');
        caja.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
          + 'background:rgba(12,10,20,.82);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px';
        document.body.appendChild(caja);
      }
      caja.innerHTML = '<div style="background:#fff;color:#1d1726;border-radius:14px;padding:24px 22px;max-width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.35)">'
        + (girando ? '<div style="width:34px;height:34px;margin:0 auto 14px;border:4px solid #e7e0ee;border-top-color:#7b3fe4;border-radius:50%;animation:lgp 0.8s linear infinite"></div><style>@keyframes lgp{to{transform:rotate(360deg)}}</style>' : '')
        + '<div style="font-weight:700;font-size:18px;margin-bottom:6px">' + titulo + '</div>'
        + '<div style="color:#4a4257">' + texto + '</div>'
        + (girando ? '' : '<button style="margin-top:16px;background:#7b3fe4;color:#fff;border:0;border-radius:10px;padding:11px 20px;font:600 15px system-ui,sans-serif;cursor:pointer">Entendido</button>')
        + '</div>';
      var b = caja.querySelector('button'); if (b) b.onclick = function () { caja.remove(); caja = null; };
    }
    if (document.body) pintar(); else document.addEventListener('DOMContentLoaded', pintar);
  }

  // ── EN EL SITIO NUEVO: canjear el código, guardar la sesión y recargar ya logueado ──
  if (codigo) {
    aviso('Entrando a tu cuenta…', 'Un segundo.', true);
    post('/api/pase/canjear', { codigo: codigo }).then(function (r) {
      if (r && r.token) {
        try { localStorage.setItem('ig_token', r.token); } catch (e) {}
        location.replace(limpia);
      } else aviso('El link ya se usó', 'Volvé al sitio anterior y tocá el link de nuevo.', false);
    }).catch(function () { aviso('No pudimos entrar', 'Revisá tu conexión y tocá el link de nuevo.', false); });
    return;
  }

  // ── EN EL SITIO VIEJO: pedir el pase con la sesión que el jugador ya tiene ──
  var token = null; try { token = localStorage.getItem('ig_token'); } catch (e) {}
  // Sin sesión igual se pregunta: así el servidor lo cuenta y la pantalla de Pases dice cuántos
  // tocaron el link sin estar logueados (otro navegador, otro celular).
  aviso('Te estamos llevando al sitio nuevo…', 'No cierres esta pantalla.', true);
  post('/api/pase/emitir', { token: token }).then(function (r) {
    if (r && r.ir) { location.replace(r.ir); return; }
    var m = (r && r.motivo) || 'error';
    if (m === 'sin_sesion') aviso('Primero entrá a tu cuenta', 'Iniciá sesión en este sitio y después tocá el link de nuevo.', false);
    else if (m === 'fuera' || m === 'sin_regla') aviso('Seguí jugando acá', 'Tu cuenta sigue en este sitio, no tenés que hacer nada.', false);
    else aviso('No pudimos pasarte ahora', 'Probá de nuevo en unos minutos.', false);
  }).catch(function () { aviso('No pudimos pasarte ahora', 'Revisá tu conexión y tocá el link de nuevo.', false); });
})();
