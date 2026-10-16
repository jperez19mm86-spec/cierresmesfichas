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
  if (!pasar && !codigo) { franja(); return; }

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
        + (girando ? '' : '<button style="margin-top:16px;background:#d6202a;color:#fff;border:0;border-radius:10px;padding:11px 20px;font:600 15px system-ui,sans-serif;cursor:pointer">Entendido</button>')
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
  // Sin sesión igual se pregunta: así el servidor lo cuenta y la pantalla de Pases dice cuántos
  // tocaron el link sin estar logueados (otro navegador, otro celular).
  pasarAhora(sesion());

  function sesion() { try { return localStorage.getItem('ig_token'); } catch (e) { return null; } }

  /* Ir al sitio nuevo. Si el casino corre ADENTRO de otra página (Zeus: dentro del chat viejo), hay
     que cambiar la página de arriba, no el recuadro; si esa página no lo deja, se abre aparte. El
     código va en el link, así que llega logueado igual. */
  function ir(url) {
    if (window.top === window) { location.replace(url); return; }
    try { window.top.location.href = url; return; } catch (e) {}
    var w = null; try { w = window.open(url, '_blank'); } catch (e) {}
    if (!w) location.href = url;
  }

  function pasarAhora(token) {
  aviso('Te estamos llevando al sitio nuevo…', 'No cierres esta pantalla.', true);
  post('/api/pase/emitir', { token: token }).then(function (r) {
    if (r && r.ir) { ir(r.ir); return; }
    var m = (r && r.motivo) || 'error';
    if (m === 'sin_sesion') aviso('Primero entrá a tu cuenta', 'Iniciá sesión en este sitio y después tocá el link de nuevo.', false);
    else if (m === 'fuera' || m === 'sin_regla') aviso('Seguí jugando acá', 'Tu cuenta sigue en este sitio, no tenés que hacer nada.', false);
    else aviso('No pudimos pasarte ahora', 'Probá de nuevo en unos minutos.', false);
  }).catch(function () { aviso('No pudimos pasarte ahora', 'Revisá tu conexión y tocá el link de nuevo.', false); });
  }

  /* ── LA FRANJA «Nos actualizamos · Probá ahora», adentro del casino ──
     Sólo si el pase de este sitio tiene el botón prendido y el jugador es de su caja (lo decide el
     servidor). La sesión puede aparecer después de cargar (se loguea, o el sitio la rehace), así que
     se la espera un rato. Si la cierra, no vuelve en el día. */
  function franja() {
    var HOY = new Date().toISOString().slice(0, 10);
    try { if (localStorage.getItem('lg_pase_cerrada') === HOY) return; } catch (e) {}
    var intentos = 0;
    (function esperar() {
      var t = sesion();
      if (!t) { if (++intentos < 40) setTimeout(esperar, 3000); return; }
      post('/api/pase/consultar', { token: t }).then(function (r) { if (r && r.mostrar) pintarFranja(); }).catch(function () {});
    })();
    /* El color es el de la marca del sitio (pedido de Pedro, 16-oct): rojo en Zeus, morado en Ganamos. */
    function colores() {
      return /zeus/i.test(location.hostname)
        ? { fondo: '#d6202a', fondo2: '#a3121a', texto: '#b3121b' }
        : { fondo: '#7b2ff0', fondo2: '#5418b8', texto: '#5a1bc4' };
    }
    function pintarFranja() {
      if (document.getElementById('lg-pase-franja')) return;
      var c = colores();
      var f = document.createElement('div');
      f.id = 'lg-pase-franja';
      f.setAttribute('role', 'region'); f.setAttribute('aria-label', 'Aviso');
      f.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;'
        + 'padding:calc(12px + env(safe-area-inset-top,0px)) 14px 14px;'
        + 'background:linear-gradient(100deg,' + c.fondo + ',' + c.fondo2 + ');color:#fff;'
        + 'font:16px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);'
        + 'border-bottom:3px solid rgba(255,255,255,.35)';
      // Dos renglones: arriba qué pasa, abajo el botón a lo ancho (en un celular de 375 px el título
      // no entra al lado del botón — medido en ganamoschat.com).
      f.innerHTML = '<style>@keyframes lgLate{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(255,255,255,.75)}50%{transform:scale(1.03);box-shadow:0 0 0 9px rgba(255,255,255,0)}}'
        + '#lg-pase-franja [data-ir]{animation:lgLate 1.6s ease-in-out infinite}'
        + '@media (prefers-reduced-motion:reduce){#lg-pase-franja [data-ir]{animation:none}}</style>'
        + '<div style="display:flex;align-items:center;gap:12px;max-width:640px;margin:0 auto">'
        + '<div style="font-size:34px;line-height:1" aria-hidden="true">🎉</div>'
        + '<div style="flex:1;min-width:0"><div style="font-weight:800;font-size:21px;letter-spacing:.2px">¡Nos actualizamos!</div>'
        + '<div style="opacity:.95;font-size:15px;margin-top:3px">Seguí jugando con tu misma cuenta</div></div>'
        + '<button data-cerrar aria-label="Cerrar" style="align-self:flex-start;background:transparent;color:#fff;border:0;font-size:26px;line-height:1;padding:0 2px 6px 8px;cursor:pointer;opacity:.85">×</button></div>'
        + '<button data-ir style="display:block;width:100%;max-width:640px;margin:12px auto 0;background:#fff;color:' + c.texto + ';border:0;border-radius:14px;padding:15px 18px;font:800 18px system-ui,sans-serif;cursor:pointer">Probá ahora →</button>';
      f.querySelector('[data-ir]').onclick = function () { f.remove(); pasarAhora(sesion()); };
      f.querySelector('[data-cerrar]').onclick = function () { f.remove(); try { localStorage.setItem('lg_pase_cerrada', HOY); } catch (e) {} };
      document.body.appendChild(f);
    }
  }
})();
