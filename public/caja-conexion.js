/**
 * caja-conexion.js — enchufa la app al motor de verdad.
 *
 * La app se escribió como prototipo con datos de ejemplo. En vez de reescribirla entera de una,
 * este archivo va reemplazando las piezas UNA POR UNA: sobrescribe la función que traía datos
 * falsos por otra que los pide a /api/caja/*. Lo que todavía no está conectado sigue andando con
 * los ejemplos, y se ve marcado en pantalla — así en cualquier momento se sabe qué es real.
 *
 * Se carga DESPUÉS de la app, así que puede pisar lo que necesite.
 */
(function () {
  'use strict';

  /* ══════ el pasamanos ══════ */
  /* 🔴 Las notas rosas explican el motor por dentro —`statistic_type`, `userGroup`, nombres de
     campos— y están marcadas en el código como «SOLO PROTOTIPO, no va en producción». Viven en el
     mismo archivo porque el panel es una copia de la maqueta, así que se esconden acá: la maqueta
     las conserva para nosotros, el cliente no las ve. */
  (function ocultarNotasDelPrototipo() {
    const e = document.createElement('style');
    e.id = 'nota-motor-fuera';
    e.textContent = '.nota.motor{display:none !important}';
    document.head.appendChild(e);
  })();

  /* 🔴 NINGUNA FALLA PUEDE QUEDAR MUDA. Antes, si `fetch` reventaba —servidor apagado, red
     cortada— la excepción no la agarraba nadie: el botón volvía a su lugar y no aparecía ningún
     mensaje. Y si el casino se colgaba, la espera era de dos minutos sin decir nada.
     Ahora toda llamada tiene tope de tiempo y todo fallo vuelve con una explicación que sirve
     para hacer algo: qué pasó, y qué probar. */
  const ESPERA_MAX = 30000;

  async function llamar(url, opciones, queEs) {
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), ESPERA_MAX);
    try {
      const r = await fetch(url, Object.assign({ credentials: 'same-origin', signal: corte.signal }, opciones));
      const d = await r.json().catch(() => null);
      if (d) {
        /* El número de caso del servidor viaja en una cabecera. Se pega a la respuesta para que
           las pantallas de error lo puedan mostrar: es el puente entre lo que vio la persona y lo
           que quedó anotado del otro lado. */
        try { d.caso = r.headers.get('X-Caso') || null; } catch (e) { d.caso = null; }
        if (r.status === 401 && d.relogin) volverAlLogin('Se venció la sesión. Entrá de nuevo.');
        if (!d.ok) seccionNegada(queEs, d.error);
        return d;
      }
      return { ok: false, error: `El servidor contestó algo que no se entiende (código ${r.status}).`,
        detalle: `${queEs} · HTTP ${r.status}` };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, agotado: true,
          error: 'El casino no contestó en 30 segundos. Suele ser el casino, no vos: '
            + 'esperá un momento y probá de nuevo.', detalle: `${queEs} · tiempo agotado` };
      }
      return { ok: false, error: 'No se pudo hablar con el sistema. Fijate que tengas conexión; si '
        + 'estás en la computadora del sistema, puede que el servidor esté apagado.',
        detalle: `${queEs} · ${e && e.message ? e.message : 'falló la conexión'}` };
    } finally {
      clearTimeout(reloj);
    }
  }

  /* 🔴 CUANDO EL MOTOR NIEGA UNA SECCIÓN, LA PESTAÑA SE VA. El menú se arma con una lista fija
     —ver el comentario largo de `MENU_ROL` en caja.html: `area=buttons` no sirve para armarlo—,
     así que la lista puede quedar corta o larga. Si queda larga, esto lo corrige solo la primera
     vez que se toca, sin ninguna llamada de más: se aprovecha la respuesta que ya vino.
     Sólo se actúa ante un «no» explícito del motor; un error de red no saca nada. */
  function seccionNegada(ruta, error) {
    const sec = seccionNegadaPor(ruta, error);   // caja-logica.js, cubierto por los tests
    if (sec && typeof window.sacarSeccion === 'function') window.sacarSeccion(sec);
  }

  const API = {
    pedir(ruta, params = {}) {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
      return llamar(`/api/caja/${ruta}${qs.toString() ? '?' + qs : ''}`, {}, ruta);
    },
    enviar(ruta, cuerpo) {
      return llamar(`/api/caja/${ruta}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      }, ruta);
    },
  };

  /* Lo que el motor ya contestó, para no volver a preguntar en cada repintado.

     🔴 CON FECHA DE VENCIMIENTO. Sin esto, lo guardado no caducaba nunca: si tu superior te cargaba
     fichas, tu pantalla mostraba el número viejo hasta que hicieras algo o recargaras la página.
     En una pantalla de plata eso es inaceptable. Un minuto es el equilibrio: no vuelve a preguntar
     mientras navegás, pero nada queda viejo más que eso.

     Mantiene la misma forma que un Map para no tocar los treinta lugares que ya lo usan. */
  const VIDA_CACHE = 60000;
  const cache = (() => {
    const m = new Map();
    const vivo = (k) => {
      const e = m.get(k);
      if (!e) return false;
      if (Date.now() - e.t > VIDA_CACHE) { m.delete(k); return false; }
      return true;
    };
    return {
      has: (k) => vivo(k),
      get: (k) => (vivo(k) ? m.get(k).v : undefined),
      set: (k, v) => { m.set(k, { v, t: Date.now() }); },
      delete: (k) => m.delete(k),
      clear: () => m.clear(),
      keys: () => m.keys(),
      [Symbol.iterator]: function* () { for (const k of [...m.keys()]) if (vivo(k)) yield [k, m.get(k).v]; },
    };
  })();
  /* El botón de «mirar el saldo» necesita tirar lo guardado: si no, vuelve a mostrar el número
     viejo, que es justo lo que no hay que hacer después de un corte por tiempo. */
  window.olvidarTodo = () => cache.clear();

  const conCache = async (clave, traer) => {
    if (cache.has(clave)) return cache.get(clave);
    const v = await traer();
    cache.set(clave, v);
    return v;
  };
  const olvidar = (prefijo) => {
    for (const k of [...cache.keys()]) if (k.startsWith(prefijo)) cache.delete(k);
  };

  /* ══════ traducción: lo que devuelve el motor → lo que la app espera ══════ */

  /* Los balances llegan como {"ARS": "12,400.00"} y con separadores de miles. */
  const plata = (v) => {
    if (v == null) return 0;
    if (typeof v === 'object') v = Object.values(v)[0];
    return Number(String(v).replace(/[^\d.-]/g, '')) || 0;
  };
  const cuantos = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'object') v = Object.values(v)[0];
    return Number(String(v).replace(/[^\d]/g, '')) || 0;
  };

  /* El motor devuelve el RTP como "90.17" — sin símbolo y con punto. Acá se escribe como se lee
     en el resto del panel: coma decimal y por ciento. */
  const comoRTP = (v) => {
    if (v == null) return '—';
    const limpio = String(v).replace(/[^\d.-]/g, '');
    /* Sin esto, `Number('')` da 0 y un valor basura se muestra como «0,0%» — un número que
       parece medido y no lo es. */
    if (limpio === '' || limpio === '-') return '—';
    const n = Number(limpio);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(1).replace('.', ',') + '%';
  };

  const aCuenta = (u, esSala) => ({
    id: String(u.id),
    login: u.login,
    name: u.name || '',
    balance: plata(u.balances),
    online: u.online === '1' || u.online === 1 || u.online === true,
    /* 🔴 El motor NO da el último ingreso: `last` viene vacío en el 100% de los medidos.
       Nada de inventar una fecha acá. */
    jugando: false,
    ...(esSala ? {
      terminals: cuantos(u.terminals),
      terminals_online: cuantos(u.terminals_online),
      terminals_game: cuantos(u.terminals_game),
    } : { sala: null }),
  });

  /* ══════ 0 · LA FECHA DE VERDAD ══════
     🔴 La maqueta tiene el día congelado para que los ejemplos se vean siempre igual. En la app
     conectada eso es un error caro y silencioso: «esta semana» se calculaba contra esa fecha vieja
     y el panel le pedía al motor un rango que terminaba días atrás — mostrando menos movimientos
     de los que hubo, sin ningún aviso. Acá manda el reloj.
     ⚠️ Pendiente: el motor usa la zona horaria de CADA CUENTA (`timezone` en su ficha), así que
     un cliente con huso corrido puede ver un corte distinto al de su reloj. */
  HOY = new Date();

  /* ══════ 1 · ENTRAR: la identidad la manda el casino ══════ */

  function volverAlLogin(aviso) {
    try { clearInterval(latido); window.__caja_sesion = null; mostrar('login'); } catch (e) {}
    if (aviso) avisarEnLogin(aviso);
  }

  function avisarEnLogin(texto, malo = true) {
    let caja = document.getElementById('avisoLogin');
    if (!caja) {
      caja = document.createElement('div');
      caja.id = 'avisoLogin';
      caja.className = 'nota';
      const btn = document.querySelector('.tarjeta .btn');
      if (btn) btn.parentElement.insertBefore(caja, btn);
    }
    caja.style.cssText = malo
      ? 'background:rgba(255,120,140,.18); color:#fff; margin:2px 0 10px'
      : 'background:rgba(255,255,255,.12); color:#fff; margin:2px 0 10px';
    caja.innerHTML = texto;
  }

  /* El mensaje explica qué hacer; el detalle técnico va abajo, chiquito y plegado, porque a vos no
     te sirve pero a quien tenga que arreglarlo sí. */
  function avisarConDetalle(texto, detalle) {
    avisarEnLogin(detalle
      ? `${texto}<div style="margin-top:8px; font-size:11px; opacity:.75; font-family:ui-monospace,monospace">${detalle}</div>`
      : texto);
  }

  /* 🔴 La maqueta trae usuario y clave escritos en el HTML —`GanamosxLatam` y `ejemplo`— para
     poder mostrarla sin tipear. En el panel de verdad eso confunde: parece que ya hay una sesión,
     o que ésa es la contraseña de alguien. Se vacían los dos.
     A cambio, el usuario SÍ se recuerda: el último con el que se entró bien, guardado en este
     navegador. Eso es una comodidad real, no un valor inventado. */
  const ULTIMO = 'caja_ultimo_usuario';
  (function limpiarLogin() {
    const u = document.getElementById('u');
    const c = document.getElementById('p');
    if (c) c.value = '';
    if (!u) return;
    let recordado = '';
    try { recordado = localStorage.getItem(ULTIMO) || ''; } catch (e) { recordado = ''; }
    u.value = recordado;
    if (!recordado) setTimeout(() => { try { u.focus(); } catch (e) {} }, 60);
    else if (c) setTimeout(() => { try { c.focus(); } catch (e) {} }, 60);
  })();

  /* Apaga (o revive) los dos campos del login. Ver el porqué en `entrarDeVerdad`. */
  /* 🔴 EL CAMPO DE CONTRASEÑA SE SACA DEL DOCUMENTO, NO SE APAGA. Chrome decide si ofrecer
     guardar la clave mirando el campo: mientras siga ahí, cada vez que la pantalla cambia vuelve a
     preguntar — y aparecía en un momento raro, pasando del hub al panel, no al entrar. Sacándolo
     no queda a qué agarrarse. Se guarda para devolverlo al salir. Reportado el 2-sep-2026. */
  let campoClaveGuardado = null;
  function apagarLogin(apagar) {
    const u = document.getElementById('u');
    if (u) { if (apagar) { u.value = ''; u.blur(); } u.disabled = !!apagar; }

    if (apagar) {
      const p = document.getElementById('p');
      if (p) { p.value = ''; p.blur(); campoClaveGuardado = { el: p, donde: p.parentNode, antes: p.nextSibling }; p.remove(); }
    } else if (campoClaveGuardado && campoClaveGuardado.donde) {
      const { el, donde, antes } = campoClaveGuardado;
      el.value = ''; el.disabled = false;
      donde.insertBefore(el, antes);
      campoClaveGuardado = null;
    }
  }

  /* Al salir vuelven a hacer falta. `salir()` la declara caja.html con `function`, así que está
     en `window` y se puede envolver sin tocar el archivo de la maqueta. */
  const salirDeLaMaqueta = window.salir;
  window.salir = function salirYReviviElLogin() {
    try { apagarLogin(false); } catch (e) { /* seguir: salir importa más */ }

    /* 🔴 SALIR TIENE QUE CERRAR LA SESIÓN DEL SERVIDOR, no sólo cambiar de pantalla.
       Así estaba: `salir()` hacía `mostrar('login')` y nada más. La cookie seguía viva, así que
       alcanzaba con recargar la página para volver a entrar sin la clave. En un teléfono que se
       presta o se pierde, eso es la caja abierta.
       Medido el 1-sep-2026: después de «Salir», la misma cookie seguía contestando `/api/caja/yo`.
       No se espera la respuesta: la pantalla vuelve al login igual, y si la red falla el servidor
       igual vence la sesión sola. Lo que no puede pasar es que no se pida. */
    try {
      window.__caja_sesion = null;
      API.enviar('logout', {});
    } catch (e) { /* que un error acá no impida salir */ }

    if (typeof salirDeLaMaqueta === 'function') return salirDeLaMaqueta.apply(this, arguments);
    return undefined;
  };

  window.entrar = async function entrarDeVerdad() {
    const usuario = (document.getElementById('u') || {}).value || '';
    const clave = (document.getElementById('p') || {}).value || '';
    const btn = document.querySelector('.tarjeta .btn');
    /* Un solo mensaje para toda la entrada. Antes eran tres —«Entrando…», «Verificando con el
       casino…» y «Leyendo tu saldo…»— y cambiaban entre sí: parecía que algo se trababa. */
    if (btn) { btn.disabled = true; btn.textContent = 'Validando…'; }

    if (!usuario || !clave) {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
      return avisarEnLogin(!usuario ? 'Escribí tu usuario' : 'Escribí tu contraseña');
    }

    const r = await API.enviar('login', { usuario, clave });
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    if (!r || !r.ok) {
      return avisarConDetalle(
        (r && r.error) || 'No se pudo entrar, y el sistema no dijo por qué.',
        r && r.detalle);
    }

    window.__caja_sesion = r.yo;
    cache.clear();
    try { localStorage.setItem(ULTIMO, r.yo.login || usuario); } catch (e) {}

    /* 🔴 LOS CAMPOS DEL LOGIN SE APAGAN APENAS ENTRA. No es prolijidad: es lo único que calla a
       Chrome.

       Esto es una sola página: la tarjeta de login no se destruye, se esconde. Mientras siga
       existiendo un <input type="password"> junto a uno de usuario, Chrome ve un formulario de
       acceso vivo, y cada vez que la pantalla cambia de forma —cargar fichas, traer los
       movimientos— lo lee como «envió el formulario» y dispara «¿Quieres actualizar la
       contraseña?».

       Ya se probaron dos cosas que NO alcanzan, y conviene que quede escrito para no repetirlas:
         · `autocomplete="off"`  → Chrome lo ignora en campos de contraseña, hace años.
         · borrar sólo el valor  → el campo sigue estando, y Chrome se guía por el campo.
       Lo que sí funciona es `disabled`: un campo deshabilitado queda afuera de la detección de
       credenciales. Se vuelven a habilitar en `salir()`, que es cuando hacen falta de nuevo. */
    try { apagarLogin(true); } catch (e) { /* si no están los campos, no hay nada que apagar */ }

    /* La app decide qué dibujar según ROL: se lo damos con lo que dijo el motor, no con un
       selector. `area=info` devolvió el group y de ahí sale el rol. */
    /* 🔴 `fijarNivel`, no `window.ROL = ...`: ver el comentario largo en caja.html. La
       asignación directa no llega al `let` del panel. Qué grupo es qué nivel lo decide
       `nivelDeGrupo`, en caja-logica.js, donde lo cubren los tests. */
    const grupo = Number(r.yo.group);
    const nivel = nivelDeGrupo(grupo);
    fijarNivel(nivel.rol, nivel.subagente);
    CUENTAS[ROL] = Object.assign({}, CUENTAS[ROL], {
      id: r.yo.id, login: r.yo.login, group: grupo,
      currency: r.yo.moneda || 'ARS',
      nivel: SUBAGENTE ? 'Sub-agente'
        : { agente: 'Agente', cajero: 'Cajero', subcajero: 'Sub-cajero' }[ROL],
      /* El de la maqueta era 100.000. Fuera antes de que se pinte nada. */
      balance: null,
    });

    /* 🔴 EL SALDO NO ES DECORACIÓN: `maxAlta()` sale de `bolsillo().balance`, así que es el tope
       de lo que el panel deja cargar. Si entramos sin él, o con el de la maqueta, el cliente ve un
       límite que no es suyo. Por eso se espera acá y, si no llega, NO se entra. */
    /* ⚡ El saldo ya viene en la respuesta del login: el backend lo saca del mismo `info` que usó
       para validarte. Antes se pedía de nuevo — una llamada idéntica, ~250 ms, en el momento en
       que más se nota. Sólo se pregunta aparte si por algo no vino. */
    if (typeof r.yo.balance === 'number') {
      CUENTAS[ROL].balance = r.yo.balance;
    } else {
      const s = await API.pedir('yo');
      if (!s.ok || !s.yo || typeof s.yo.balance !== 'number') {
        window.__caja_sesion = null;
        return avisarConDetalle('Entraste bien, pero el casino no contestó tu saldo. Probá de nuevo '
          + 'en un momento.', s && s.detalle);
      }
      CUENTAS[ROL].balance = s.yo.balance;
      if (s.yo.moneda) CUENTAS[ROL].currency = s.yo.moneda;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    const aviso = document.getElementById('avisoLogin');
    if (aviso) aviso.remove();
    arrancarLatido();
    esAgente() ? irHub() : irPanel();
  };

  /* ══════ 2 · LAS CUENTAS que cuelgan del nodo ══════ */

  const yoId = () => (window.__caja_sesion || {}).id;


  /* Corrige el saldo de una cuenta dentro de la lista guardada, sin volver a pedirla. */
  function parchearCuentas(id, saldo) {
    if (typeof saldo !== 'number') return;
    for (const [clave, valor] of cache) {
      if (!clave.startsWith('cuentas:') || !valor || !valor.cuentas) continue;
      for (const c of valor.cuentas) {
        /* 🔑 En la fila CRUDA del motor el saldo se llama `balances` y viene como
           {"ARS":"12,400.00"} — `aCuenta` lo traduce con `plata()`. Escribir `balance` acá no
           serviría de nada: el que se lee después es `balances`. */
        if (String(c.id) === String(id)) c.balances = String(saldo);
      }
    }
  }

  async function traerCuentas(nodo, esSala) {
    const d = await conCache(`cuentas:${nodo}`, () => API.pedir('cuentas', { id: nodo, limite: 200 }));
    if (!d.ok) return { error: d.error };
    return { lista: (d.cuentas || []).map((u) => aCuenta(u, esSala)), paginas: d.paginas };
  }

  /* 🔴 NO se puede reemplazar `hijos()`: la app la declara con `const`, así que sus llamadas
     internas resuelven al binding original y cualquier `window.hijos = …` queda colgado sin uso.
     Lo mismo vale para todo lo declarado con const/let.

     Así que en vez de cambiar la FUNCIÓN, se cambian los DATOS que esa función lee: `SALAS` y
     `TERMINALES` son `let` del scope global y sí se pueden reasignar desde acá. La app sigue
     haciendo exactamente lo que hacía; lo único distinto es de dónde salen las cuentas. */
  const yaPedido = new Set();
  let ORIGEN = 'ejemplo';           // qué se está mostrando ahora mismo: 'servidor' o 'ejemplo'

  function cargarCuentas(nodo, esSala, alTerminar) {
    const clave = `cuentas:${nodo}`;
    if (cache.has(clave)) return volcar(cache.get(clave), nodo, esSala, alTerminar);
    if (yaPedido.has(clave)) return;
    yaPedido.add(clave);
    API.pedir('cuentas', { id: nodo, limite: 200 }).then((d) => {
      cache.set(clave, d);
      yaPedido.delete(clave);
      volcar(d, nodo, esSala, alTerminar);
    });
  }

  function volcar(d, nodo, esSala, alTerminar) {
    if (!d.ok) { ORIGEN = 'error'; ultimoError = d.error; }
    else {
      const lista = (d.cuentas || []).map((u) => aCuenta(u, esSala));
      if (esSala) SALAS = lista;
      else { lista.forEach((x) => { x.sala = nodo; }); TERMINALES = lista; }
      ORIGEN = 'servidor';
    }
    if (alTerminar) alTerminar();
  }

  let ultimoError = '';

  /* `pintarUsuarios` sí es `function`, así que ésta sí se puede envolver: se usa como el momento
     en que hay que asegurarse de tener las cuentas del nodo que se está mirando. */
  const usuariosOriginal = window.pintarUsuarios;
  window.pintarUsuarios = function pintarUsuariosDeVerdad() {
    if (!window.__caja_sesion) return usuariosOriginal.apply(this, arguments);
    const esSala = viendoSalas();
    const nodo = DENTRO || yoId();
    const clave = `cuentas:${nodo}`;
    if (!cache.has(clave)) {
      ORIGEN = 'cargando';
      cargarCuentas(nodo, esSala, () => pintarUsuarios());
      cargando('Un momento, tus cuentas se están cargando', 'lista');
      return;
    }
    volcar(cache.get(clave), nodo, esSala);
    usuariosOriginal.apply(this, arguments);
  };

  /* ══════ 3 · MOVIMIENTOS de fichas ══════ */

  /* El motor manda `cash` como texto con separadores; la app espera números. */
  const aMovimiento = (m) => ({
    operation: m.operation,
    cash: plata(m.cash),
    cash_before: plata(m.cash_before),
    datetime: m.datetime,
    initiator: m.initiator || '',
    system: m.system || '',
    user: m.user || '',
    ip: m.ip || '',
  });

  /* Qué rango está mirando la app: se lee de su propia función, para no duplicar el calendario. */
  const rangoActual = () => {
    try { return rango(PER_MOV, 'mov'); } catch (e) { const h = new Date().toISOString().slice(0, 10); return { from: h, to: h }; }
  };

  const pintarMovsOriginal = window.pintarMovs;
  window.pintarMovs = function pintarMovsDeVerdad() {
    if (!window.__caja_sesion) return pintarMovsOriginal.apply(this, arguments);
    const nodo = DENTRO || yoId();
    const r = rangoActual();
    const clave = `movs:${nodo}:${TIPO_MOV}:${r.from}:${r.to}`;

    if (cache.has(clave)) {
      const d = cache.get(clave);
      /* Se rellena la estructura que la app ya sabe pintar. */
      const cual = DENTRO ? 'cajero' : (ROL === 'subcajero' ? 'cajero' : ROL);
      MOVS[cual] = MOVS[cual] || {};
      MOVS[cual][TIPO_MOV] = (d.movimientos || []).map(aMovimiento);
      pintarMovsOriginal.apply(this, arguments);
      if (d.parcial) avisarParcial(d);
      return;
    }
    cargando('Un momento, estamos trayendo tus movimientos');
    if (!yaPedido.has(clave)) {
      yaPedido.add(clave);
      API.pedir('movimientos', { id: nodo, tipo: TIPO_MOV, desde: r.from, hasta: r.to, limite: 500 })
        .then((d) => { cache.set(clave, d); yaPedido.delete(clave); pintarMovs(); });
    }
  };

  function avisarParcial(d) {
    const cuerpo = document.getElementById('cuerpo');
    if (!cuerpo) return;
    const n = document.createElement('div');
    n.className = 'nota aviso';
    n.innerHTML = `Hay <b>más movimientos</b> de los que entran en una página. Los totales de
      arriba son de lo que ves; el total del período está en Resumen.`;
    cuerpo.appendChild(n);
  }

  /* ══════ ESPERAR SIN ANSIEDAD ══════
     Un texto quieto —«Buscando las cuentas…»— no dice si algo avanza o si se colgó, y a los tres
     segundos se siente eterno. Un esqueleto sí: muestra la FORMA de lo que viene y late, así que
     el ojo entiende «está armándose» sin leer nada. Además la transición al contenido real es
     suave, porque lo que aparece ocupa el mismo lugar que la silueta. */
  const CSS_ESQUELETO = `
    .esq{display:flex; flex-direction:column; gap:9px; padding:2px 0}
    .esq .fila{display:flex; align-items:center; gap:11px; background:var(--bg2);
      border:1px solid var(--bor); border-radius:12px; padding:14px 13px}
    .esq .bulto{background:var(--bg3); border-radius:7px; height:12px; animation:latir 1.4s ease-in-out infinite}
    .esq .fila .redondo{width:9px; height:9px; border-radius:50%; flex:none}
    .esq .fila .largo{flex:1; max-width:170px}
    .esq .fila .corto{width:74px; height:26px; border-radius:9px; margin-left:auto}
    .esq .tarjeta-esq{background:var(--bg2); border:1px solid var(--bor); border-radius:13px;
      padding:16px 14px; display:flex; flex-direction:column; gap:10px}
    .esq .grilla{display:grid; grid-template-columns:1fr 1fr; gap:9px}
    /* Cada fila arranca un poco después que la anterior: la onda se lee como progreso. */
    .esq .fila:nth-child(2) .bulto{animation-delay:.12s}
    .esq .fila:nth-child(3) .bulto{animation-delay:.24s}
    .esq .fila:nth-child(4) .bulto{animation-delay:.36s}
    .esq .fila:nth-child(5) .bulto{animation-delay:.48s}
    .esq .fila:nth-child(6) .bulto{animation-delay:.6s}
    @keyframes latir{0%,100%{opacity:.55} 50%{opacity:1}}
    /* Si tarda de más, recién ahí se explica con palabras — y los puntos siguen moviéndose,
       porque un texto quieto es justo lo que hace pensar que se colgó. */
    .esq .demora{text-align:center; font-size:13px; color:var(--mut2); padding:14px 0 2px}
    .esq .demora i{font-style:normal; animation:puntito 1.2s steps(1,end) infinite}
    .esq .demora i:nth-child(2){animation-delay:.2s}
    .esq .demora i:nth-child(3){animation-delay:.4s}
    @keyframes puntito{0%,60%{opacity:0} 30%{opacity:1}}
    @media (prefers-reduced-motion:reduce){
      .esq .bulto{animation:none; opacity:.7}
      .esq .demora i{animation:none; opacity:1} }`;

  (function ponerEstilos() {
    const s = document.createElement('style');
    s.textContent = CSS_ESQUELETO;
    document.head.appendChild(s);
  })();

  const filaEsq = () => `<div class="fila">
    <span class="bulto redondo"></span><span class="bulto largo"></span><span class="bulto corto"></span></div>`;

  const FORMAS = {
    lista: (n = 6) => `<div class="esq">${Array.from({ length: n }, filaEsq).join('')}</div>`,
    tarjetas: () => `<div class="esq">
      <div class="grilla">
        <div class="tarjeta-esq"><span class="bulto" style="width:60%"></span><span class="bulto" style="width:40%;height:22px"></span></div>
        <div class="tarjeta-esq"><span class="bulto" style="width:60%"></span><span class="bulto" style="width:40%;height:22px"></span></div>
      </div>
      <div class="tarjeta-esq">
        <span class="bulto" style="width:45%"></span>
        <div class="grilla"><span class="bulto" style="height:20px"></span><span class="bulto" style="height:20px"></span>
          <span class="bulto" style="height:20px"></span><span class="bulto" style="height:20px"></span></div>
        <span class="bulto" style="height:60px;border-radius:10px"></span>
      </div></div>`,
    tabla: () => `<div class="esq">
      <div class="tarjeta-esq"><span class="bulto" style="width:70%"></span>
        <div class="grilla"><span class="bulto" style="height:18px"></span><span class="bulto" style="height:18px"></span>
          <span class="bulto" style="height:18px"></span><span class="bulto" style="height:18px"></span></div></div>
      ${Array.from({ length: 5 }, filaEsq).join('')}</div>`,
  };

  /* Qué silueta corresponde a cada pantalla. */
  const SILUETA = { users: 'lista', balance: 'lista', sub: 'lista',
                    dashboard: 'tarjetas', reports: 'tabla',
                    intersections: 'lista', changes: 'lista' };

  let relojDemora = null;
  function cargando(texto, forma) {
    const cuerpo = document.getElementById('cuerpo');
    if (!cuerpo) return;
    const cual = forma || SILUETA[typeof SEC === 'string' ? SEC : ''] || 'lista';
    cuerpo.innerHTML = (FORMAS[cual] || FORMAS.lista)();
    /* Recién si pasa de tres segundos aparece el texto: hasta ahí, la silueta alcanza. */
    clearTimeout(relojDemora);
    relojDemora = setTimeout(() => {
      const esq = cuerpo.querySelector('.esq');
      if (!esq || esq.querySelector('.demora')) return;
      const d = document.createElement('div');
      d.className = 'demora';
      /* Los puntos van aparte para poder animarlos: quietos, el texto parece colgado. */
      d.innerHTML = `${texto || 'Un momento, estamos trayendo la información'}<i>.</i><i>.</i><i>.</i>`;
      esq.appendChild(d);
    }, 3000);
  }


  /* ══════ 3.bis · MOVER FICHAS DE VERDAD ══════
     La maqueta simulaba: sumaba y restaba en memoria con un `setTimeout` de 900 ms y siempre
     terminaba en ✓. Acá se habla con el casino, y el resultado que se muestra es el que el
     backend VERIFICÓ leyendo el saldo antes y después — no el que pedimos. */

  const gestoNuevo = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const hoja = (html) => abrirHoja(html);

  window.ejecutarMov = async function ejecutarMovDeVerdad(v) {
    if (!window.__caja_sesion) return;
    const carga = OP === 'in';
    /* `let` de nivel superior: se lee SIN `window.` — ahí no está. */
    const todo = !!TODO_EL_SALDO && !carga;
    const destino = ACTUAL;

    hoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>${carga ? 'Cargando' : 'Retirando'} ${todo ? 'todo el saldo' : fmt(v)}</h3>
      <div class="sub">Un momento, no cierres esta pantalla.</div></div>`);

    /* 🔴 EL MISMO GESTO, HASTA TRES VECES. Los dos relojes no coinciden: el navegador corta a los
       30 segundos y el servidor sigue hablando con el casino hasta 120. En el medio, la carga
       entra y el operador ve un error — que es exactamente cómo se cobró 10.000 dos veces.

       No se puede alargar la espera del navegador sin dejar la pantalla colgada dos minutos, así
       que se reintenta con el MISMO `gesto`, que es lo que el servidor usa de huella:
         · si ya terminó, devuelve el resultado guardado — no vuelve a mover una ficha;
         · si sigue en curso, el pedido espera turno en la cola y recibe lo que dio el primero.
       Un `gesto` nuevo en cada intento —que es lo que había— salteaba las dos redes. */
    const cuerpo = {
      cuenta: String(destino.id),
      login: destino.login,
      padre: DENTRO ? String(DENTRO) : undefined,
      operacion: carga ? 'in' : 'out',
      monto: todo ? undefined : v,
      todo,
      gesto: gestoNuevo(),
    };
    let r = await API.enviar('fichas', cuerpo);
    let reintente = false;
    for (let intento = 2; r && r.agotado && intento <= 3; intento++) {
      reintente = true;
      hoja(`<div class="resultado"><div class="sello latir">…</div>
        <h3>El casino está tardando</h3>
        <div class="sub">Seguimos esperando la respuesta. <b>No lo pidas de nuevo</b>: si ya entró,
        lo vamos a ver acá.</div></div>`);
      r = await API.enviar('fichas', cuerpo);
    }

    /* 🔴 EL RECIBO LLEGA VESTIDO DE ERROR. Cuando el servidor reconoce la huella contesta 409
       «esa misma operación ya se hizo», con el resultado adentro. Para un doble clic de verdad
       está bien avisar así. Pero si el que repitió fui yo —porque se venció el reloj— eso NO es
       un error: la carga entró, y mostrarle una ✕ roja al operador lo empuja a repetirla otra
       vez. Se muestra lo que pasó. */
    if (reintente && r && r.repetida && r.resultado) r = { ok: true, ...r.resultado, yaEstaba: true };

    /* Tres cortes seguidos: no sabemos, y se dice. Lo único que no se puede hacer es invitarlo a
       repetir, porque repetir es lo que cobra dos veces. */
    if (r && r.agotado) {
      return hoja(`<div class="resultado"><div class="sello malo">?</div>
        <h3>No sabemos si entró</h3>
        <div class="sub">El casino no contestó en todo este rato. La orden pudo haber entrado igual.
        <b>Mirá el saldo antes de volver a intentarlo.</b></div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn" onclick="olvidarTodo(); cerrarHoja(); pintar()">Mirar el saldo</button></div>`);
    }

    /* Ya hay un movimiento corriendo sobre esta cuenta. NO es un error y no se muestra como
       tal: si sale la ✕ roja, el operador vuelve a apretar, que es justo lo que hay que evitar.
       Se dice que espere y se le ofrece mirar el saldo, no reintentar. */
    if (!r.ok && r.enCurso) {
      return hoja(`<div class="resultado"><div class="sello">⏳</div>
        <h3>Esperá un momento</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Entendido</button></div>`);
    }

    /* El motor aceptó la orden y no movió nada: el caso que más engaña. */
    if (!r.ok && r.sinEfecto) {
      if (typeof r.saldo === 'number') destino.balance = r.saldo;
      pintar();
      return hoja(`<div class="resultado"><div class="sello malo">!</div>
        <h3>No se movió nada</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Entendido</button></div>`);
    }
    if (!r.ok) {
      return hoja(`<div class="resultado"><div class="sello malo">✕</div>
        <h3>No se pudo</h3>
        <div class="sub">${r.error || 'El casino no contestó.'} ${r.repetida ? '' :
          'Revisá el saldo antes de intentarlo otra vez.'}</div></div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    }

    /* 🔴 La lista de cuentas está GUARDADA en memoria para no repreguntar, y el repintado la
       vuelve a leer: sin tocarla, pisa el saldo que acabamos de traer y la pantalla muestra el
       número de antes aunque la plata se haya movido (encontrado el 29-ago: el motor decía 2 y la
       pantalla 0).
       ⚡ Se le CORRIGE el saldo adentro en vez de tirarla: tirarla obliga a pedir la lista entera
          otra vez —otros ~220 ms— justo cuando el cliente está esperando. */
    olvidar(`trans:${destino.id}:`);   // sus movimientos cambiaron
    parchearCuentas(String(destino.id), r.despues);
    if (r.pagador && typeof r.pagador.saldo === 'number') parchearCuentas(String(r.pagador.id), r.pagador.saldo);

    /* Se movió. Los saldos que se muestran son los MEDIDOS, no los calculados. */
    destino.balance = r.despues;

    /* 🔴 Y el de QUIEN PAGA también cambió. Adentro de una caja, las fichas salen de la caja —no
       de tu cuenta— así que refrescar sólo el saldo propio dejaba el número de arriba viejo justo
       después de mover plata. (Encontrado el 29-ago probándolo en el panel.) */
    if (r.pagador && typeof r.pagador.saldo === 'number') {
      const caja = SALAS.find((c) => String(c.id) === String(r.pagador.id));
      if (caja) caja.balance = r.pagador.saldo;
      if (String(r.pagador.id) === String(yoId())) CUENTAS[ROL].balance = r.pagador.saldo;
    } else {
      const s = await API.pedir('yo');
      if (s.ok && s.yo && typeof s.yo.balance === 'number') CUENTAS[ROL].balance = s.yo.balance;
    }
    pintar();

    const dif = Math.abs(r.movido);
    hoja(`<div class="resultado"><div class="sello">✓</div>
      <h3>${carga ? 'Fichas cargadas' : 'Fichas retiradas'}</h3>
      <div class="sub"><b class="mono">${destino.login}</b> quedó con
        <b class="num">${yo().currency} ${fmt(r.despues)}</b></div>
      ${r.parcial ? `<div class="sub" style="margin-top:8px"><b>Se movieron ${fmt(dif)}, no lo que pediste.</b>
        Puede que el jugador tuviera otro saldo al confirmar.</div>` : ''}
      </div>
      <div class="acciones"><button class="btn" onclick="cerrarHoja()">Listo</button></div>`);
  };


  /* ══════ 3.ter · ALTA Y BAJA DE CUENTAS, de verdad ══════
     La maqueta inventaba el id (`7357580 + SALAS.length`) y decidía si el login estaba libre
     mirando una lista escrita a mano: ['test','admin','ganamos']. Y `borrar()` no borraba nada:
     su botón llamaba a `cerrarHoja()`.

     🔴 El motor no avisa si el alta funcionó —contesta lo mismo creando que rebotando—, así que
        el backend verifica volviendo a pedir la lista. Lo que se muestra acá es ESO. */

  window.crear = async function crearDeVerdad() {
    if (!window.__caja_sesion) return;
    const login = ($('nlogin').value || '').trim();
    const clave = ($('nclave').value || '').trim();
    const grupo = $('ngrupo').value;
    const bal = $('nbal') ? Number(String($('nbal').value).replace(/[^\d]/g, '')) || 0 : 0;

    const pasos = ['Creando la cuenta', 'Verificando que quedó creada'];
    const dibujar = (i, fallo) => abrirHoja(`
      <h3 id="hojaTit">Creando <span class="mono">${login}</span></h3>
      <div class="sub">Tarda unos segundos.</div>
      <div class="pasos">${pasos.map((p, k) => `
        <div class="paso ${fallo && k === 1 ? 'mal' : k < i ? 'hecho' : k === i ? 'curso' : ''}">
          <span class="mk">${fallo && k === 1 ? '✕' : k < i ? '✓' : k + 1}</span><span>${p}</span>
        </div>`).join('')}</div>`);
    dibujar(0);

    /* Se guarda ANTES de mandar: si el motor dice que el login está ocupado, el formulario se
       vuelve a abrir con la contraseña y el balance ya puestos y sólo hay que cambiar el nombre. */
    window.ALTA_PREVIA = { grupo, login, clave, bal: bal || '' };

    const r = await API.enviar('crear', {
      padre: DENTRO ? String(DENTRO) : undefined,
      login, clave,
      tipo: grupo === '4' ? 'cajero' : grupo === '8' ? 'subcajero' : 'jugador',
      saldo: bal || undefined,
    });

    if (!r.ok) {
      dibujar(1, true);
      const ocupado = !!r.ocupado;
      return setTimeout(() => abrirHoja(`
        <div class="resultado"><div class="sello malo">✕</div>
          <h3>${ocupado ? 'Ese nombre ya está usado' : 'No se pudo crear'}</h3>
          <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button>
          ${/* 🔴 VUELVE AL MISMO FORMULARIO, no al selector. Antes llamaba a `abrirAlta()`, que
                abre «¿Qué querés crear?»: entrabas a crear un jugador, el login estaba ocupado,
                apretabas «Probar otro nombre» y aparecías eligiendo otra vez si querías un
                jugador o un sub-cajero. Se perdía lo que ya habías decidido.
                `grupo` es el tipo que se estaba creando, así que se vuelve exactamente ahí. Los
                sub-cajeros tienen su propio formulario y por eso van aparte. */''
          }${ocupado ? (grupo === '8'
              ? `<button class="btn" onclick="altaSubCajero('${DENTRO || (window.__caja_sesion || {}).id}')">Probar otro nombre</button>`
              : `<button class="btn" onclick="altaFormulario('${grupo}', true)">Probar otro nombre</button>`) : ''}
        </div>`), 500);
    }

    window.ALTA_PREVIA = null;   // salió bien: la contraseña no se guarda ni un segundo más
    olvidar('cuentas:');   // la cuenta nueva no está en la copia guardada
    /* El id y el saldo son los que el casino confirmó, no los que pedimos. */
    const c = r.cuenta;
    const id = String(c.id);
    const saldoReal = Number(c.balance) || 0;
    if (grupo === '4') {
      SALAS.unshift({ id, login, name: c.name || login, balance: saldoReal,
        terminals: 0, terminals_online: 0, terminals_game: 0, phone: '', online: false });
      SUBAGENTES.forEach((s) => { s.cajas[id] = false; });
    } else {
      TERMINALES.unshift({ id, login, password: clave, balance: saldoReal,
        online: false, jugando: false, sala: DENTRO || CUENTAS.cajero.id, ultimo: 'nunca' });
    }
    /* Las fichas salieron de la caja: el saldo propio cambió. */
    const s = await API.pedir('yo');
    if (s.ok && s.yo && typeof s.yo.balance === 'number') CUENTAS[ROL].balance = s.yo.balance;
    pintar();

    if (grupo === '4' && SUBAGENTES.length) return preguntarQuienLaVe(id, login);

    /* El link lo da el motor: `TICKET_URL` es una constante de la maqueta y el dominio es por
       caja. Recién creada la cuenta, se le pregunta por su acceso. */
    const a = await accesoDe(id);
    const acceso = (a.ok && a.acceso) || `Login:${login} Contraseña:${clave}`;
    const link = (a.ok && a.link) || '';
    abrirHoja(`
      <div class="resultado"><div class="sello">✓</div>
        <h3>Creado</h3>
        <div class="sub"><b class="mono">${login}</b> · ID ${id} · verificado en el casino${
          saldoReal ? ` · con ${fmt(saldoReal)} ${yo().currency}` : ''}</div></div>
      ${r.parcial ? `<div class="nota">⚠️ <b>Le pediste ${fmt(r.saldoPedido)} y quedó con ${fmt(saldoReal)}.</b>
        Revisá el saldo de la caja antes de darle más.</div>` : ''}
      ${filaCred('Usuario y contraseña', acceso, true)}
      ${link ? filaCred('Link de acceso directo', link, true) : `<div class="nota">${SIN_LINK}</div>`}
      <div class="nota"><b>Las dos cosas valen lo mismo que la contraseña.</b> Mandá una sola vez
      y pedile que la cambie.</div>
      <div class="acciones">
        <button class="btn sec" onclick="compartirTexto(\`${acceso}${link ? '\n' + link : ''}\`)">Compartir</button>
        <button class="btn" onclick="cerrarHoja()">Listo</button>
      </div>
      <div style="text-align:center;margin-top:12px">
        <button class="icobtn" onclick="abrirNodo('${id}')">Ver la cuenta y sus acciones ›</button>
      </div>`);
  };

  /* La baja: los textos de la maqueta están cuidados y aprobados, así que NO se reescriben.
     Se dibuja la hoja original y se le cambia la acción al botón rojo, que hasta ahora sólo
     cerraba la hoja. */
  const borrarOriginal = window.borrar;
  window.borrar = function borrarConAccion() {
    borrarOriginal.apply(this, arguments);
    if (!window.__caja_sesion) return;
    const destino = ACTUAL;
    const btn = document.querySelector('.acciones .btn.peligro');
    if (btn) btn.onclick = () => ejecutarBaja(destino);
  };

  async function ejecutarBaja(destino) {
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Eliminando ${destino.login}</h3>
      <div class="sub">Un momento, no cierres esta pantalla.</div></div>`);

    const r = await API.enviar('eliminar', {
      cuenta: String(destino.id), login: destino.login,
      padre: DENTRO ? String(DENTRO) : undefined,
      confirmado: true,
    });

    if (!r.ok) {
      return abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>${r.sinEfecto ? 'No se borró' : 'No se pudo'}</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    }

    olvidar('cuentas:');   // la copia guardada todavía la tiene
    /* Fuera de la lista que se ve. El array es el mismo objeto: se muta, no se reasigna. */
    for (const arr of [SALAS, TERMINALES]) {
      const i = arr.findIndex((x) => String(x.id) === String(destino.id));
      if (i >= 0) arr.splice(i, 1);
    }
    if (DENTRO && String(DENTRO) === String(destino.id)) volverARaiz(); else pintar();

    abrirHoja(`<div class="resultado"><div class="sello">✓</div>
      <h3>Eliminado</h3>
      <div class="sub"><b class="mono">${destino.login}</b> ya no puede entrar a jugar.
      Se puede restaurar; el login queda tomado para siempre.</div></div>
      <div class="acciones"><button class="btn" onclick="cerrarHoja()">Listo</button></div>`);
  }


  /* ══════ 3.quater · QUÉ CAJAS VE CADA SUB-AGENTE ══════
     La maqueta marcaba el permiso en memoria y mostraba el ✓. Ahora se lo pide al motor y se
     confirma leyendo — si el casino acepta y no aplica, se dice.

     🔴 El valor que habilita es `1`. Mandar `on` (lo que manda el formulario del panel, por ser
        una casilla HTML) BORRA el permiso. Eso lo resuelve el backend; acá sólo se manda
        verdadero/falso por caja. */

  async function guardarPermisos(subId, cajas, alTerminar) {
    const r = await API.enviar('permisos-subagente', { sub: String(subId), cajas });
    if (!r.ok) {
      abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>${r.sinEfecto ? 'No quedó aplicado' : 'No se pudo'}</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
      return false;
    }
    /* Se refleja lo que el motor CONFIRMÓ, no lo que pedimos. */
    const s = SUBAGENTES.find((x) => String(x.id) === String(subId));
    const cajasConfirmadas = {};
    for (const [id, e] of Object.entries(r.estado || {})) cajasConfirmadas[id] = !!(e && e.ve);
    if (s) s.cajas = cajasConfirmadas;
    if (alTerminar) alTerminar();
    return true;
  }

  /* Una palanca dentro de «qué cajas ve este sub-agente». */
  window.tocarCaja = async function tocarCajaDeVerdad(subId, cajaId) {
    if (!window.__caja_sesion) return;
    const s = SUBAGENTES.find((x) => String(x.id) === String(subId));
    const nuevo = !(s && s.cajas[cajaId]);
    await guardarPermisos(subId, { [cajaId]: nuevo }, () => { abrirSubAgente(subId); pintarSub(); });
  };

  window.todasLasCajas = async function todasLasCajasDeVerdad(subId) {
    if (!window.__caja_sesion) return;
    const cajas = {};
    SALAS.forEach((c) => { cajas[c.id] = true; });
    if (!Object.keys(cajas).length) return;
    await guardarPermisos(subId, cajas, () => { abrirSubAgente(subId); pintarSub(); });
  };

  /* Y el otro sentido: recién creada una caja, a qué sub-agentes se les habilita. */
  window.aplicarVisibilidad = async function aplicarVisibilidadDeVerdad(cajaId, cajaLogin) {
    if (!window.__caja_sesion) return;
    const elegidos = [...ELEGIDOS];
    if (!elegidos.length) { cerrarHoja(); pintar(); return; }

    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Habilitando <span class="mono">${cajaLogin}</span></h3>
      <div class="sub">Un momento…</div></div>`);

    const listos = [], fallaron = [];
    for (const id of elegidos) {
      const ok = await guardarPermisos(id, { [cajaId]: true });
      const s = SUBAGENTES.find((x) => String(x.id) === String(id));
      (ok ? listos : fallaron).push((s && s.login) || id);
    }
    pintar();
    if (!listos.length) return;   // el error ya se mostró
    abrirHoja(`<div class="resultado"><div class="sello">✓</div>
      <h3>Listo</h3>
      <div class="sub">${listos.length === 1
        ? `<b class="mono">${listos[0]}</b> ya ve`
        : `<b>${listos.length} sub-agentes</b> ya ven`} <b class="mono">${cajaLogin}</b> y sus jugadores.
        ${fallaron.length ? `<br><br>No se pudo con: <b>${fallaron.join(', ')}</b>.` : ''}</div></div>
      <div class="acciones"><button class="btn" onclick="cerrarHoja(); pintar()">Listo</button></div>`);
  };


  /* ══════ 3.quinquies · CONTRASEÑAS ══════
     La maqueta mostraba el ✓ sin hablar con nadie. Ahora se cambia de verdad y se verifica:
     la propia, entrando con la nueva; la de otro, releyéndola del motor. */

  window.guardarMiClave = async function guardarMiClaveDeVerdad() {
    if (!window.__caja_sesion) return;
    const actual = ($('pAnt') || {}).value || '';
    const nueva = ($('pNue') || {}).value || '';
    const repite = ($('pRep') || {}).value || '';
    if (nueva !== repite) return;   // la app ya lo bloquea, pero por si acaso
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Cambiando tu contraseña</h3><div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('mi-clave', { actual, nueva });
    if (!r.ok) {
      return abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>No se cambió</h3><div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cambiarMiClave()">Probar de nuevo</button></div>`);
    }
    /* El backend ya cerró la sesión: con la clave vieja no se entra más. */
    abrirHoja(`<div class="resultado"><div class="sello">✓</div>
      <h3>Contraseña cambiada</h3>
      <div class="sub">Entrá de nuevo con la nueva.</div></div>
      <div class="acciones"><button class="btn" onclick="salir()">Entendido</button></div>`);
  };

  window.guardarClaveDeOtro = async function guardarClaveDeOtroDeVerdad(id) {
    if (!window.__caja_sesion) return;
    const nueva = ($('oNue') || {}).value || '';
    const cuenta = (SALAS.concat(TERMINALES)).find((x) => String(x.id) === String(id)) || {};
    const esJugador = TERMINALES.some((x) => String(x.id) === String(id));
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Cambiando la contraseña de ${cuenta.login || id}</h3>
      <div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('clave-de', { cuenta: String(id), nueva, esJugador });
    if (!r.ok) {
      return abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>No se cambió</h3><div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    }
    if (cuenta.password !== undefined) cuenta.password = nueva;
    olvidarAcceso(id);   // el link lleva la clave adentro: el guardado quedó viejo
    abrirHoja(`<div class="resultado"><div class="sello">✓</div>
      <h3>Contraseña cambiada</h3>
      <div class="sub"><b class="mono">${cuenta.login || id}</b> ahora entra con la nueva.
      Si estaba jugando, quedó afuera: pasásela.</div></div>
      <div class="acciones"><button class="btn" onclick="cerrarHoja()">Listo</button></div>`);
  };


  /* ══════ 3.sexies · MEDIOS DE COMUNICACIÓN ══════
     La maqueta guardaba en `CONTACTOS[caja]` y listo. Ahora habla con el motor y se repinta con lo
     que quedó guardado — el link lo arma el casino, así que es lo único que prueba que salió bien.

     🔑 El motor numera los contactos `contact_1..N` y ese número (`n`) es lo que hay que mandarle.
        Se guarda en cada fila para no depender de la posición del array, que cambia al borrar. */

  async function traerContactos(cajaId, alTerminar) {
    const r = await API.pedir('contactos', { caja: cajaId });
    if (!r.ok) return null;
    CONTACTOS[cajaId] = (r.contactos || []).map((c) => ({
      n: c.n, id: c.id, type: c.type, title: c.title, contact: c.contact, description: c.description,
    }));
    /* 🔑 «Usar los medios de tu cuenta» NO es un ajuste del motor: no existe tal casilla. Es una
       CONSECUENCIA — una caja muestra los suyos si tiene, y si no tiene hereda los del agente.
       Así que el estado se deriva de los datos en vez de guardarse aparte, y no puede mentir. */
    USA_PROPIOS[cajaId] = CONTACTOS[cajaId].length > 0;
    if (alTerminar) alTerminar();
    return CONTACTOS[cajaId];
  }

  const errorEnHoja = (r, volverA) => abrirHoja(
    `<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
      <h3>${r.sinEfecto ? 'No quedó guardado' : 'No se pudo'}</h3>
      <div class="sub">${r.error}</div>${pieCaso(r)}</div>
     <div class="acciones"><button class="btn sec" onclick="${volverA}">Volver</button></div>`);

  /* 🔴 «Medios de comunicación» DE TU PROPIA FICHA llama a `misContactos`, no a
     `abrirContactos`. Son dos funciones distintas y sólo estaba envuelta la segunda: desde la
     ficha del agente la pantalla abría con la lista de la maqueta —vacía— y el operador veía un
     botón que «no sirve». Se envuelve igual que la otra, pidiendo los del propio nodo.
     Encontrado el 1-sep-2026 recorriendo la aplicación con una cuenta real. */
  const misContactosOriginal = window.misContactos;
  window.misContactos = function misContactosDeVerdad() {
    if (!window.__caja_sesion) return misContactosOriginal.apply(this, arguments);
    const mio = String(window.__caja_sesion.id);
    if (CONTACTOS[mio]) return misContactosOriginal.apply(this, arguments);
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Medios de comunicación</h3>
      <div class="sub">Un momento, estamos trayéndolos del casino.</div></div>`);
    traerContactos(mio, () => misContactosOriginal.call(window));
    return undefined;
  };

  const contactosOriginal = window.abrirContactos;
  window.abrirContactos = function abrirContactosDeVerdad(cajaId) {
    if (!window.__caja_sesion) return contactosOriginal.apply(this, arguments);
    if (CONTACTOS[cajaId]) return contactosOriginal.apply(this, arguments);
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Medios de comunicación</h3>
      <div class="sub">Un momento, estamos trayéndolos del casino.</div></div>`);
    traerContactos(cajaId, () => contactosOriginal.call(window, cajaId));
  };

  window.guardarContacto = async function guardarContactoDeVerdad(cajaId, i, tipo) {
    if (!window.__caja_sesion) return;
    const lista = CONTACTOS[cajaId] || [];
    const previo = i >= 0 ? lista[i] : null;
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Guardando</h3><div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('contacto', {
      caja: String(cajaId), n: previo ? previo.n : 0, tipo,
      contacto: ($('cContacto') || {}).value || '',
      /* El título y la descripción ya no se piden —el jugador no los ve— pero se REENVÍAN los
         que la ficha ya tenía. Si se mandaran vacíos, editar un número para corregir un dígito
         borraría de paso un título que alguien cargó alguna vez. No pedir un dato no es lo mismo
         que borrarlo. */
      titulo: (previo && previo.title) || '',
      descripcion: (previo && previo.description) || '',
    });
    if (!r.ok) return errorEnHoja(r, `editarContacto('${cajaId}',${i})`);
    CONTACTOS[cajaId] = (r.contactos || []).map((c) => ({ ...c }));
    volverContactos(cajaId);
  };

  window.borrarContacto = async function borrarContactoDeVerdad(cajaId, i) {
    if (!window.__caja_sesion) return;
    const c = (CONTACTOS[cajaId] || [])[i];
    if (!c) return;
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Borrando</h3><div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('contacto-borrar', { caja: String(cajaId), n: c.n });
    if (!r.ok) return errorEnHoja(r, `abrirContactos('${cajaId}')`);
    CONTACTOS[cajaId] = (r.contactos || []).map((x) => ({ ...x }));
    volverContactos(cajaId);
  };


  /* ══════ 3.septies · EL LINK DE JUGADORES ══════
     Regla del dueño: el dominio NO se deduce nunca. La maqueta lo armaba con una constante
     (`TICKET_URL`), que es exactamente lo que no hay que hacer: `ticket_url` es un campo POR CAJA
     y puede estar vacío. Acá se le pide al motor el link ya armado. */

  const ACCESOS = new Map();
  async function accesoDe(id) {
    const k = String(id);
    if (!ACCESOS.has(k)) ACCESOS.set(k, await API.pedir('acceso', { cuenta: k }));
    return ACCESOS.get(k);
  }
  const olvidarAcceso = (id) => ACCESOS.delete(String(id));

  const SIN_LINK = 'Esta caja no tiene dominio configurado, así que no hay link para dar. '
    + 'Se lo puede pedir a soporte.';

  /* Las tres pantallas que muestran el acceso, con los textos de la maqueta intactos. */
  window.copiar = async function copiarDeVerdad(texto, mensaje) {
    if (!window.__caja_sesion) return;
    if (navigator.clipboard) navigator.clipboard.writeText(texto).catch(() => {});
    const a = await accesoDe(ACTUAL.id);
    abrirHoja(`<div class="resultado"><div class="sello">✓</div><h3>${mensaje}</h3>
        <div class="sub">Ya está en el portapapeles. Las dos cosas, por si querés la otra:</div></div>
      ${filaCred('Usuario y contraseña', (a.ok && a.acceso) || '—', true)}
      ${a.ok && a.link ? filaCred('Link de acceso directo', a.link, true)
                       : `<div class="nota">${SIN_LINK}</div>`}
      <div class="nota"><b>Valen lo mismo que la contraseña.</b> Mandá una sola vez y pedile que la cambie.</div>
      <div class="acciones">
        <button class="btn sec" onclick="abrirNodo('${ACTUAL.id}')">Volver</button>
        <button class="btn" onclick="cerrarHoja()">Listo</button>
      </div>`);
  };

  window.enviarCredenciales = async function enviarCredencialesDeVerdad() {
    if (!window.__caja_sesion) return;
    const a = await accesoDe(ACTUAL.id);
    window.__envio = { clave: (a.ok && a.acceso) || '', link: (a.ok && a.link) || '' };
    pintarEnvio(null);
  };

  window.compartir = async function compartirDeVerdad() {
    if (!window.__caja_sesion) return;
    const a = await accesoDe(ACTUAL.id);
    const texto = (a.ok && a.compartir) || (a.ok && a.acceso) || '';
    if (!texto) return abrirHoja(`<div class="resultado"><div class="sello malo">!</div>
      <h3>No hay nada para compartir</h3><div class="sub">${SIN_LINK}</div></div>
      <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    compartirTexto(texto);
  };


  /* La ficha de la caja necesita su dominio REAL antes de dibujarse. */
  const editarCajaOriginal = window.editarCaja;
  window.editarCaja = async function editarCajaDeVerdad(id) {
    if (!window.__caja_sesion) return editarCajaOriginal.apply(this, arguments);
    const caja = SALAS.find((c) => String(c.id) === String(id));
    if (caja && caja.ticket_url === undefined) {
      const d = await API.pedir('dominio', { caja: String(id) });
      caja.ticket_url = d.ok ? (d.url || '') : '';
    }
    return editarCajaOriginal.call(window, id);
  };


  /* Guardar el dominio que el cajero escribe. El backend lo verifica contra «Dominios permitidos»
     antes de escribirlo: un dominio que no está habilitado no le va a funcionar a nadie. */
  window.guardarDominio = async function guardarDominio(cajaId) {
    if (!window.__caja_sesion) return;
    const campo = document.getElementById('domNuevo');
    const aviso = document.getElementById('avisoDom');
    const url = (campo && campo.value || '').trim();
    if (!url) { if (aviso) aviso.textContent = 'Escribí el link primero'; return; }
    if (aviso) aviso.textContent = 'Validando…';
    const r = await API.enviar('dominio', { caja: String(cajaId), url });
    if (!r.ok) { if (aviso) aviso.innerHTML = r.error; return; }
    const caja = SALAS.find((c) => String(c.id) === String(cajaId));
    if (caja) caja.ticket_url = r.url;
    ACCESOS.clear();          // los links de sus jugadores cambian con el dominio
    /* Guardado, pero sin haber podido comprobarlo contra los dominios habilitados: se dice.
       Callarlo sería dar por bueno un link que quizá no le abre a nadie. */
    if (r.aviso) { if (aviso) aviso.textContent = r.aviso; return; }
    editarCaja(cajaId);
  };


  /* ══════ 3.octies · ALTA DE SUB-USUARIOS ══════
     La maqueta inventaba el id (`7357900 + SUBCAJEROS.length`). Ahora se crea de verdad y el id
     que se muestra es el que asignó el casino.

     🔴 Un sub-usuario NO aparece en la lista de cuentas: vive en `area=sub`. Eso lo resuelve el
        backend, que verifica el alta ahí y no en `users`. */

  async function altaDeSub(tipo, { padre, login, clave, alCrear }) {
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Creando <span class="mono">${login}</span></h3>
      <div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('crear', { padre: String(padre), login, clave, tipo });
    if (!r.ok) {
      const ocupado = !!r.ocupado;
      return abrirHoja(`<div class="resultado"><div class="sello malo">✕</div>
        <h3>${ocupado ? 'Ese nombre ya está usado' : 'No se pudo crear'}</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    }
    alCrear(String(r.cuenta.id), r.cuenta);
  }

  window.crearSubCajero = function crearSubCajeroDeVerdad(cajaId) {
    if (!window.__caja_sesion) return;
    const login = ($('scLogin') || {}).value.trim();
    const clave = ($('scClave') || {}).value.trim();
    return altaDeSub('subcajero', { padre: cajaId, login, clave, alCrear: (id) => {
      SUBCAJEROS.unshift({ id, login, name: login, sala: cajaId,
        disable_statistic: false, hide_hall_balance: false });
      pintarSub();
      abrirHoja(`<div class="resultado"><div class="sello">✓</div>
        <h3>Sub-cajero creado</h3>
        <div class="sub"><b class="mono">${login}</b> · ID ${id} · verificado en el casino</div></div>
        ${filaCred('Usuario y contraseña', `Login:${login} Contraseña:${clave}`, true)}
        <div class="acciones">
          <button class="btn sec" onclick="abrirSubDeCaja('${cajaId}')">Listo</button>
          <button class="btn" onclick="abrirSub('${id}')">Configurar permisos</button></div>`);
    } });
  };

  window.crearSub = function crearSubDeVerdad() {
    if (!window.__caja_sesion) return;
    const login = ($('sLogin') || {}).value.trim();
    const clave = ($('sClave') || {}).value.trim();
    return altaDeSub('subagente', { padre: yoId(), login, clave, alCrear: (id) => {
      const cajas = {}; SALAS.forEach((c) => { cajas[c.id] = false; });
      SUBAGENTES.unshift({ id, login, name: login, cajas });
      pintarSub();
      /* Nace sin ver ninguna caja —medido: `users` sobre sí mismo devuelve 0— así que el paso
         siguiente no es opcional, y por eso se dice acá y no en una pantalla aparte. */
      abrirHoja(`<div class="resultado"><div class="sello">✓</div>
        <h3>Sub-agente creado</h3>
        <div class="sub"><b class="mono">${login}</b> · ID ${id} · verificado en el casino</div></div>
        ${filaCred('Usuario y contraseña', `Login:${login} Contraseña:${clave}`, true)}
        <div class="nota">Todavía <b>no ve ninguna caja</b>. Hasta que le habilites al menos una,
        entra y no encuentra nada.</div>
        <div class="acciones">
          <button class="btn sec" onclick="cerrarHoja()">Después</button>
          <button class="btn" onclick="abrirSubAgente('${id}')">Elegir qué cajas ve</button></div>`);
    } });
  };


  /* Las palancas de un sub-cajero: saldo oculto y estadísticas. Ahora se guardan en el motor y la
     pantalla se repinta con lo que quedó, no con lo que se pidió. */
  window.tocarPermiso = async function tocarPermisoDeVerdad(id, campo) {
    if (!window.__caja_sesion) return;
    const s = SUBCAJEROS.find((x) => String(x.id) === String(id));
    if (!s) return;
    const r = await API.enviar('permisos-subcajero', { sub: String(id), permisos: { [campo]: !s[campo] } });
    if (!r.ok) {
      return abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>${r.sinEfecto ? 'No quedó guardado' : 'No se pudo'}</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="abrirSub('${id}')">Volver</button></div>`);
    }
    for (const [k, v] of Object.entries(r.estado || {})) s[k] = v;
    /* 🔴 Sin esto, `abrirSub` vuelve a leer el estado GUARDADO —el de antes de tocar— y la palanca
       aparece como si nada hubiera pasado. El cambio se había hecho igual; sólo no se veía.
       Se guarda el estado que el motor CONFIRMÓ, así el repintado muestra la verdad. */
    cache.set(`permsub:${id}`, { ok: true, estado: r.estado || {} });
    abrirSub(id);
    pintarSub();
  };


  /* La palanca de origen. No hay ajuste que tocar: para que la caja use los suyos hay que cargarle
     uno, y para que vuelva a los del agente hay que sacarle los que tenga. Se dice tal cual. */
  window.cambiarOrigen = async function cambiarOrigenDeVerdad(cajaId) {
    if (!window.__caja_sesion) return;
    const propios = CONTACTOS[cajaId] || [];
    if (!propios.length) return editarContacto(cajaId, -1);   // no tiene: que cargue el primero

    const caja = SALAS.find((c) => String(c.id) === String(cajaId)) || {};
    abrirHoja(`<h3 id="hojaTit">Volver a tus medios</h3>
      <div class="sub"><b class="mono">${caja.login || cajaId}</b> tiene
        ${propios.length === 1 ? 'un contacto propio' : propios.length + ' contactos propios'}.</div>
      <div class="nota">Para que sus jugadores vuelvan a ver <b>tu línea de soporte</b>, hay que
      sacarle los suyos. No hay forma de tenerlos guardados y apagados: el casino muestra los de la
      caja si los tiene, y los tuyos si no.</div>
      <div class="acciones">
        <button class="btn sec" onclick="abrirContactos('${cajaId}')">Volver</button>
        <button class="btn peligro" onclick="sacarPropios('${cajaId}')">Sacarle los suyos</button>
      </div>`);
  };

  window.sacarPropios = async function sacarPropios(cajaId) {
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Sacando sus contactos</h3><div class="sub">Un momento…</div></div>`);
    for (const c of [...(CONTACTOS[cajaId] || [])].reverse()) {
      const r = await API.enviar('contacto-borrar', { caja: String(cajaId), n: c.n });
      if (!r.ok) return errorEnHoja(r, `abrirContactos('${cajaId}')`);
      CONTACTOS[cajaId] = (r.contactos || []).map((x) => ({ ...x }));
    }
    USA_PROPIOS[cajaId] = (CONTACTOS[cajaId] || []).length > 0;
    abrirContactos(cajaId);
  };


  /* ══════ 3.novies · LAS TRANSACCIONES DE UN JUGADOR ══════
     La hoja que se abre al tocar un jugador leía `MOVS_JUGADOR`, que son los datos de ejemplo de la
     maqueta: mostraba «0 movimientos» aunque el motor tuviera dos cargas de ese mismo día.

     🔑 Sobre un JUGADOR, `usual:to` y `usual:from` devuelven lo mismo (medido el 31-ago), así que
        alcanza con una llamada. El eje de bonos es otro tipo de movimiento, no otro filtro. */

  const transOriginal = window.transaccionesDe;
  window.transaccionesDe = function transaccionesDeVerdad(id) {
    if (!window.__caja_sesion) return transOriginal.apply(this, arguments);
    const r = rango(MJ_PER, 'jug');
    const tipo = MJ_BONOS ? 'bonuses:all' : 'usual:to';
    const clave = `trans:${id}:${tipo}:${r.from}:${r.to}`;

    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return errorEnHoja(d, `abrirNodo('${id}')`);
      /* El array es el que la app ya sabe pintar; se marca el bono para que sus pestañas filtren. */
      MOVS_JUGADOR[id] = (d.movimientos || []).map((m) => ({
        ...aMovimiento(m), bono: MJ_BONOS || undefined,
      }));
      return transOriginal.call(window, id);
    }

    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Movimientos</h3><div class="sub">Un momento…</div></div>`);
    pedirUnaVez(clave, () => API.pedir('movimientos', {
      id: String(id), tipo, desde: r.from, hasta: r.to, limite: 500,
    }), () => transaccionesDe(id));
  };


  /* ══════ 3.decies · BUSCAR UN JUGADOR EN TODA LA RED ══════
     El caso del dueño: «me piden fichas para un jugador y tengo que revisar veinte cajas para
     saber dónde está». Ahora la misma caja de búsqueda, además de filtrar la lista que ves,
     le pregunta al motor por toda tu red — una llamada, ~260 ms — y te deja entrar de una. */

  let BUSCA_ULTIMA = '';
  let BUSCA_TIMER = null;

  function pintarHallazgos(q, filas, buscando) {
    const lista = document.getElementById('lista');
    if (!lista) return;
    const previo = document.getElementById('hallazgos');
    if (previo) previo.remove();
    if (!q) return;

    const caja = (id) => (SALAS.find((c) => String(c.id) === String(id)) || {}).login || id;
    const d = document.createElement('div');
    d.id = 'hallazgos';
    d.style.marginTop = '14px';

    if (buscando) {
      d.innerHTML = '<div class="rot">Buscando en todas tus cajas…</div>';
    } else if (!filas.length) {
      d.innerHTML = `<div class="rot">En tus otras cajas</div>
        <div class="nota neutra">Ninguna cuenta se llama así.</div>`;
    } else {
      d.innerHTML = `<div class="rot">En tus otras cajas · ${filas.length}</div>
        <div class="lista">${filas.map((f) => `
          <div class="fila-b" onclick="irAJugador('${f.caja}','${f.id}')" style="cursor:pointer">
            <span class="id"><b class="mono">${f.login}</b>
              <span>${f.tipo === 'jugador' ? 'Jugador' : f.tipo} · en <b>${caja(f.caja)}</b></span></span>
            <span class="fl">›</span>
          </div>`).join('')}</div>`;
    }
    lista.insertAdjacentElement('afterend', d);
  }

  /* Entrar a la caja del jugador y abrirlo, que es lo que se quiere hacer al encontrarlo. */
  window.irAJugador = function irAJugador(cajaId, jugadorId) {
    const filtro = document.getElementById('filtro');
    if (filtro) filtro.value = '';
    entrarEn(String(cajaId));
    setTimeout(() => abrirNodo(String(jugadorId)), 400);
  };

  /* ⚠️ Más abajo hay OTRO reemplazo de `pintarFilas` —el del cartel «esto es real»—, así que
     cada uno guarda el anterior con su propio nombre y los dos se encadenan. */
  const filasAntesDeBuscar = window.pintarFilas;
  window.pintarFilas = function pintarFilasConBusqueda() {
    filasAntesDeBuscar.apply(this, arguments);
    if (!window.__caja_sesion) return;
    const q = ((document.getElementById('filtro') || {}).value || '').trim();
    if (q.length < 3) { BUSCA_ULTIMA = ''; pintarHallazgos('', []); return; }
    if (q === BUSCA_ULTIMA) return;                 // ya está pintado
    BUSCA_ULTIMA = q;
    pintarHallazgos(q, [], true);

    /* Se espera a que termine de escribir: sin esto son cinco llamadas para «maria». */
    clearTimeout(BUSCA_TIMER);
    BUSCA_TIMER = setTimeout(async () => {
      const r = await API.pedir('buscar-jugador', { q });
      const actual = ((document.getElementById('filtro') || {}).value || '').trim();
      if (actual !== q) return;                     // ya escribió otra cosa
      const aqui = new Set(hijos().map((x) => String(x.id)));
      const filas = (r.ok ? r.encontrados : [])
        .filter((f) => f.caja && !aqui.has(String(f.id)));   // los de esta lista ya se ven arriba
      pintarHallazgos(q, filas, false);
    }, 450);
  };


  /* ══════ 3.undecies · EL HISTORIAL DE JUGADAS ══════
     Medido el 31-ago: `area=history` devuelve UNA FILA POR JUGADA, con su `id` propio y el
     `session` al que pertenece. Los dos niveles de la pantalla salen de ahí:

       nivel 1 · sesiones  → las filas AGRUPADAS por `session`
       nivel 2 · jugadas   → los miembros de cada grupo

     🔴 No hay endpoint aparte para las jugadas de una sesión. Probados `session` en el cuerpo y en
        la query, `session_id`, `history_session`, y las áreas `historysession`, `rounds` y `bets`:
        o se ignoran o no devuelven JSON. Una sola llamada trae todo.
     🔑 `provider` y `label` ya vienen legibles («Games System», «AMIGO GAMING (OP)»): no hay que
        traducirlos con el mapa de proveedores. */

  const histOriginal = window.abrirHistoria;
  window.abrirHistoria = function abrirHistoriaDeVerdad(id) {
    if (!window.__caja_sesion) return histOriginal.apply(this, arguments);
    const r = rango(HIST_PER, 'hist');
    const clave = `hist:${id}:${r.from}:${r.to}`;

    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return errorEnHoja(d, `abrirNodo('${id}')`);
      armarHistorial(id, d.sesiones || []);
      return histOriginal.call(window, id);
    }
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Historial de juego</h3><div class="sub">Un momento…</div></div>`);
    pedirUnaVez(clave, () => API.pedir('jugadas', {
      jugador: String(id), desde: r.from, hasta: r.to, limite: 500,
    }), () => abrirHistoria(id));
  };

  function armarHistorial(id, filas) {
    const orden = [], grupos = {};
    for (const f of filas) {
      const s = String(f.session || f.id);
      if (!grupos[s]) {
        grupos[s] = {
          session: s, game: f.game || '—',
          providertitle: f.provider || '', labeltitle: f.label || '',
          bet: 0, win: 0, profit: 0,
          balance_before: plata(f.balance_before),
          round_finished: Number(f.round_finished) || 0,
          datetime_open: f.datetime_open || f.datetime_last || '',
          datetime_close: f.datetime_close || '',
          datetime_last: f.datetime_last || '',
        };
        orden.push(s);
        JUGADAS[s] = [];
      }
      const g = grupos[s];
      g.bet += plata(f.bet); g.win += plata(f.win); g.profit += plata(f.profit);
      /* La sesión abarca desde la primera jugada hasta la última. */
      if (f.datetime_open && (!g.datetime_open || f.datetime_open < g.datetime_open)) g.datetime_open = f.datetime_open;
      if (f.datetime_last && f.datetime_last > g.datetime_last) g.datetime_last = f.datetime_last;
      if (!f.datetime_close) g.datetime_close = '';        // sigue jugando

      /* Nivel 2: la jugada suelta, con los nombres que la pantalla ya sabe leer. */
      JUGADAS[s].push({
        round_id: String(f.id || ''),
        dateTime: f.datetime_last || f.datetime_open || '',
        before: plata(f.balance_before),
        bet: plata(f.bet), win: plata(f.win),
        status: Number(f.round_finished) || 0,
      });
    }
    SESIONES[id] = orden.map((s) => grupos[s]);
  }


  /* ══════ 3.duodecies · LAS CUENTAS ELIMINADAS ══════
     El aviso de «hay borrados con fichas adentro» era de ejemplo. Importa que sea real: borrar NO
     devuelve las fichas —quedan congeladas en la cuenta— así que ese número es plata que nadie
     está viendo.

     🔑 Restaurar es `area=delete` con `restore=true`. La misma área que borra. */

  async function traerEliminadas(cajaId) {
    const clave = `borradas:${cajaId}`;
    const d = cache.has(clave) ? cache.get(clave)
      : await conCache(clave, () => API.pedir('eliminadas', { caja: String(cajaId) }));
    if (!d.ok) return [];
    /* `BORRADOS` es un array plano con `sala`: se reemplaza lo de esa caja, no todo. */
    const otras = BORRADOS.filter((b) => String(b.sala) !== String(cajaId));
    const suyas = (d.eliminadas || []).map((u) => ({
      id: String(u.id), login: u.login, name: u.name || '',
      balance: plata(u.balances), sala: String(cajaId), borrado: '',
    }));
    BORRADOS.length = 0; BORRADOS.push(...otras, ...suyas);
    return suyas;
  }

  /* El aviso se dibuja con la lista que ya esté; si todavía no vino, se pide y se repinta. */
  const enlaceOriginal = window.enlaceBorrados;
  window.enlaceBorrados = function enlaceBorradosDeVerdad(cajaId) {
    if (!window.__caja_sesion) return enlaceOriginal.apply(this, arguments);
    const clave = `borradas:${cajaId}`;
    if (!cache.has(clave)) {
      pedirUnaVez(clave, () => API.pedir('eliminadas', { caja: String(cajaId) }), () => {
        traerEliminadas(cajaId).then(() => { if (SEC === 'users') pintarUsuarios(); });
      });
      return '';                       // todavía no se sabe: no se afirma nada
    }
    traerEliminadas(cajaId);
    return enlaceOriginal.call(window, cajaId);
  };

  window.restaurar = async function restaurarDeVerdad(id) {
    if (!window.__caja_sesion) return;
    const b = BORRADOS.find((x) => String(x.id) === String(id));
    if (!b) return;
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Restaurando ${b.login}</h3><div class="sub">Un momento…</div></div>`);
    const r = await API.enviar('restaurar', { cuenta: String(id), caja: String(b.sala) });
    if (!r.ok) {
      return abrirHoja(`<div class="resultado"><div class="sello malo">${r.sinEfecto ? '!' : '✕'}</div>
        <h3>${r.sinEfecto ? 'No se restauró' : 'No se pudo'}</h3>
        <div class="sub">${r.error}</div>${pieCaso(r)}</div>
        <div class="acciones"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>`);
    }
    olvidar(`borradas:${b.sala}`);
    olvidar('cuentas:');
    const i = BORRADOS.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) BORRADOS.splice(i, 1);
    TERMINALES.unshift({ id: String(id), login: r.cuenta.login, balance: plata(r.cuenta.balances),
      sala: String(b.sala), online: false, jugando: false, ultimo: 'nunca' });
    cerrarHoja(); pintarUsuarios();
  };


  /* ══════ 3.terdecies · EL SALDO SE REFRESCA SOLO ══════
     La pregunta del dueño: «si mi superior me carga fichas y yo no estoy haciendo nada, ¿en cuánto
     lo veo?». Antes: nunca. El panel sólo actualizaba cuando VOS hacías algo.

     Ahora hay un latido: cada 45 segundos relee tu saldo, y si estás mirando la lista de cuentas,
     también la relee. Sólo mientras la pestaña está a la vista — si la dejás de fondo, para y no
     gasta nada; al volver, se actualiza en el acto.

     🔑 Es la llamada más barata del motor (~250 ms) y no interrumpe: si el número no cambió, no se
        repinta nada. */

  const LATIDO_MS = 45000;
  let latido = null;
  let refrescando = false;

  async function refrescarSaldo({ tambienLista = false } = {}) {
    if (!window.__caja_sesion || refrescando) return;
    refrescando = true;
    try {
      const s = await API.pedir('yo');
      if (!s.ok || !s.yo || typeof s.yo.balance !== 'number') return;
      const antes = CUENTAS[ROL] && CUENTAS[ROL].balance;
      CUENTAS[ROL].balance = s.yo.balance;

      let cambioLista = false;
      if (tambienLista && SEC === 'users') {
        const nodo = DENTRO || yoId();
        olvidar(`cuentas:${nodo}`);
        const d = await API.pedir('cuentas', { id: nodo, limite: 200 });
        if (d.ok) { cache.set(`cuentas:${nodo}`, d); cambioLista = true; }
      }
      /* Repintar sólo si algo cambió: nadie tiene por qué ver la pantalla parpadear cada 45 s. */
      if (cambioLista || antes !== s.yo.balance) pintar();
    } finally {
      refrescando = false;
    }
  }

  function arrancarLatido() {
    clearInterval(latido);
    latido = setInterval(() => {
      if (document.visibilityState === 'visible') refrescarSaldo({ tambienLista: true });
    }, LATIDO_MS);
  }

  document.addEventListener('visibilitychange', () => {
    /* Volver a la pestaña es el momento exacto en que la persona quiere el número de ahora. */
    if (document.visibilityState === 'visible') refrescarSaldo({ tambienLista: true });
  });


  /* Los sub-cajeros de UNA caja, llegando por el menú de esa caja. Este camino no pasaba por
     `pintarSub`, así que mostraba los de la maqueta: apareció `SubCaja2`, que no existe en el
     casino, con sus palancas listas para tocar. */
  const subDeCajaOriginal = window.abrirSubDeCaja;
  window.abrirSubDeCaja = function abrirSubDeCajaDeVerdad(cajaId) {
    if (!window.__caja_sesion) return subDeCajaOriginal.apply(this, arguments);
    const clave = `sub:${cajaId}`;
    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return errorEnHoja(d, `abrirNodo('${cajaId}')`);
      /* Se reemplazan sólo los de ESTA caja: los de las otras siguen donde estaban. */
      const otros = SUBCAJEROS.filter((s) => String(s.sala) !== String(cajaId));
      const suyos = (d.subusuarios || []).map((s) => ({
        id: String(s.id), login: s.login, name: s.name || s.login, sala: String(cajaId),
        hide_hall_balance: s.hide_hall_balance === true || s.hide_hall_balance === '1',
        disable_statistic: s.disable_statistic === true || s.disable_statistic === '1',
      }));
      SUBCAJEROS.length = 0; SUBCAJEROS.push(...otros, ...suyos);
      return subDeCajaOriginal.call(window, cajaId);
    }
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>Sub-cajeros</h3><div class="sub">Un momento…</div></div>`);
    pedirUnaVez(clave, () => API.pedir('subusuarios', { id: String(cajaId) }),
      () => abrirSubDeCaja(cajaId));
  };

  /* Y la ficha de uno: sus permisos salen del motor, no de lo que quedó en memoria. */
  const abrirSubOriginal = window.abrirSub;
  window.abrirSub = function abrirSubDeVerdad(id) {
    if (!window.__caja_sesion) return abrirSubOriginal.apply(this, arguments);
    const clave = `permsub:${id}`;
    const s = SUBCAJEROS.find((x) => String(x.id) === String(id));
    if (!s || cache.has(clave)) {
      const d = cache.has(clave) ? cache.get(clave) : null;
      if (d && d.ok && s) for (const [k, v] of Object.entries(d.estado || {})) s[k] = v;
      return abrirSubOriginal.call(window, id);
    }
    abrirHoja(`<div class="resultado"><div class="sello latir">…</div>
      <h3>${s.login}</h3><div class="sub">Un momento…</div></div>`);
    pedirUnaVez(clave, () => API.pedir('permisos-subcajero', { sub: String(id) }),
      () => abrirSub(id));
  };

  /* ══════ 4 · RESUMEN — el tablero ══════ */

  /* El endpoint devuelve `charts` tal cual lo manda el motor: charts.<panel>.data.{numbers,graphic}.
     La app espera <panel>.{numbers,graphic}. Un nivel de diferencia, nada más. */
  /* 🔴 El motor devuelve los nombres de las series en SU idioma: si el panel está en inglés
     llegan «Profit», «Deposit», «Withdraw», «Amount», «Active players». Se traducen por la CLAVE,
     que no cambia nunca, y no por el texto — que sí cambia. Si aparece una serie que no conocemos,
     se usa el nombre que mandó el motor: mejor en inglés que en blanco. */
  const NOMBRE_SERIE = {
    profit: 'Ganancia', bet_win: 'GGR', ggr: 'GGR',
    deposit: 'Cargas', withdraw: 'Retiros',
    active_players: 'Jugadores', active_halls: 'Cajeros',
  };
  /* Los nombres del EJE sí se traducen por texto —el motor no da una clave para esto— así que
     hay que tenerlos todos. El 1-sep-2026 se le preguntó al motor qué manda de verdad y contestó:
     Amount · Player count · Number of visitors · Active players · Active halls · Profit · Deposit ·
     Withdraw · GGR. Faltaba «Player count» y salía en inglés abajo del gráfico: «Player count · 2
     ago a 31 ago». Están las variantes que ya había porque el motor cambia de forma entre
     versiones y no cuesta nada dejarlas. */
  const NOMBRE_EJE = {
    amount: 'Monto', 'sum of money': 'Suma de dinero',
    'player count': 'Cantidad de jugadores', 'hall count': 'Cantidad de cajeros',
    'number of players': 'Cantidad de jugadores', 'number of halls': 'Cantidad de cajeros',
    'quantity of players': 'Cantidad de jugadores', 'quantity of halls': 'Cantidad de cajeros',
    'number of visitors': 'Cantidad de visitas', 'visitor count': 'Cantidad de visitas',
    'active players': 'Jugadores con movimiento', 'active halls': 'Cajeros con movimiento',
    profit: 'Ganancia', deposit: 'Cargas', withdraw: 'Retiros', ggr: 'GGR',
  };

  const aPaneles = (charts) => {
    const t = {};
    for (const [nombre, panel] of Object.entries(charts || {})) {
      if (!panel || !panel.data) continue;
      const d = panel.data;
      if (d.graphic) {
        /* 🔴 EL MOTOR SE EQUIVOCA EN UN TÍTULO Y HAY QUE PISARLO. Medido el 1-sep-2026: para el
           panel `active_halls` —cuántos CAJEROS movieron fichas— manda `yAxisTitle: "Player
           count"`, el de jugadores. Traducido fiel, la tarjeta de cajeros decía «Cantidad de
           jugadores».
           Cuando la serie nos dice qué se está contando, mandamos nosotros; si no la conocemos,
           se usa lo que vino. La clave es confiable, el título no. */
        const porClave = {
          active_halls: 'Cantidad de cajeros',
          active_players: 'Cantidad de jugadores',
        };
        const clave0 = ((d.graphic.datasets || [])[0] || {}).key;
        d.graphic = Object.assign({}, d.graphic, {
          yAxisTitle: porClave[clave0]
            || NOMBRE_EJE[String(d.graphic.yAxisTitle || '').toLowerCase()]
            || d.graphic.yAxisTitle,
          datasets: (d.graphic.datasets || []).map((s) => Object.assign({}, s, {
            label: NOMBRE_SERIE[s.key] || s.label,
          })),
        });
      }
      t[nombre] = d;
    }
    /* `summary_stats` viene como {online_players:{total:5}}; la app lo lee plano. */
    if (t.summary_stats && t.summary_stats.numbers) {
      const n = t.summary_stats.numbers;
      t.summary_stats = Object.fromEntries(Object.entries(n)
        .map(([k, v]) => [k, (v && typeof v === 'object' ? v.total : v) || 0]));
    }
    return t;
  };


  /* El mismo tramo, corrido al período anterior. `hoy` compara contra ayer; una semana contra la
     semana pasada; un mes contra el mes pasado — siempre el mismo largo, que es lo único que hace
     comparable la cifra. */
  function tramoAnterior(r) {
    const a = new Date(r.from + 'T12:00:00');
    const b = new Date(r.to + 'T12:00:00');
    const dias = Math.round((b - a) / 86400000) + 1;
    const finPrev = new Date(a); finPrev.setDate(finPrev.getDate() - 1);
    const iniPrev = new Date(finPrev); iniPrev.setDate(iniPrev.getDate() - (dias - 1));
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(iniPrev), to: iso(finPrev) };
  }

  async function traerPrevio(nodo, r) {
    const p = tramoAnterior(r);
    const clave = `previo:${nodo}:${p.from}:${p.to}`;
    const d = cache.has(clave) ? cache.get(clave)
      : await conCache(clave, () => API.pedir('resumen', { id: nodo, desde: p.from, hasta: p.to }));
    if (!d.ok || !d.paneles) return;
    const n = (aPaneles(d.paneles).combined || {}).numbers;
    if (!n) return;
    const previo = { in: (n.deposit || {}).total, out: (n.withdraw || {}).total,
      profit: (n.profit || {}).total, ggr: (n.bet_win || {}).total };
    /* La app lee el previo de estas tablas, por período y por caja. */
    if (DENTRO) {
      TOTALES_ANTES_CAJA[DENTRO] = TOTALES_ANTES_CAJA[DENTRO] || {};
      TOTALES_ANTES_CAJA[DENTRO][PERIODO] = previo;
    } else {
      TOTALES_ANTES[PERIODO] = previo;
    }
    /* Y se repinta, ahora sí con la comparación puesta. */
    if (SEC === 'dashboard') tableroOriginal.call(window);
  }

  const tableroOriginal = window.pintarTablero;
  window.pintarTablero = function pintarTableroDeVerdad() {
    if (!window.__caja_sesion) return tableroOriginal.apply(this, arguments);
    const nodo = DENTRO || yoId();
    /* 🔴 Se mandan las MISMAS fechas que el encabezado muestra. Pedirle al motor `type:'week'`
       devuelve un rango relativo a un estado pegado en su sesión —un jueves 27 contestó del 20 al
       25—, así que el rótulo y los números hablaban de días distintos. */
    const r = (() => { try { return rangoTab(); } catch (e) { return rangoActual(); } })();
    const clave = `tablero:${nodo}:${r.from}:${r.to}`;
    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return errorEnPantalla(d.error);
      const paneles = aPaneles(d.paneles);
      if (DENTRO) TABLERO_CAJA[DENTRO] = paneles; else Object.assign(TABLERO, paneles);
      tableroOriginal.apply(this, arguments);
      /* La comparación «vs el período anterior» era de ejemplo. Se pide DESPUÉS de dibujar: es un
         dato secundario y no tiene por qué hacer esperar a los números principales. */
      traerPrevio(nodo, r);
      return;
    }
    cargando('Un momento, estamos armando tu resumen');
    pedirUnaVez(clave, () => API.pedir('resumen', { id: nodo, desde: r.from, hasta: r.to }), pintarTablero);
  };

  /* ══════ 5 · ESTADÍSTICAS ══════ */

  const estadisticasOriginal = window.pintarEstadisticas;
  window.pintarEstadisticas = function pintarEstadisticasDeVerdad() {
    if (!window.__caja_sesion) return estadisticasOriginal.apply(this, arguments);
    const nodo = DENTRO || yoId();
    if (EST_TIPO !== 'on_money') EST_TIPO = 'on_money';

    /* 🔴 «POR CAJA» SÓLO EXISTE EN EL NIVEL DEL AGENTE. Adentro de una caja, sus hijos son
       jugadores, así que agrupar «por caja» devuelve jugadores con el rótulo equivocado — que es
       exactamente lo que se vio el 28-ago.
       Y se entra a una caja sin darse cuenta: `resumenDeCaja()` deja `DENTRO` puesto y navegar por
       las pestañas de arriba NO lo limpia. Como `gruposDisponibles()` es `const` y no se puede
       pisar, se corrige el estado acá y se saca el botón del DOM después de dibujar. */
    if (DENTRO && EST_GRUPO === 'child_users') EST_GRUPO = 'terminal';

    /* El mismo rango que dibuja la app: `rango(EST_PER,'est')`. Sin esta línea `r` no existe y
       el botón de estadísticas ampliadas no hacía nada. */
    const r = rango(EST_PER, 'est');
    const clave = `est:${nodo}:${EST_TIPO}:${EST_GRUPO}:${r.from}:${r.to}`;
    if (cache.has(clave)) {
      const d = cache.get(clave);
      /* Demasiados jugadores para pedir las apuestas de a uno: se dice con el número y con la
         salida, en vez de dejar la pantalla vacía o colgada. */
      if (!d.ok && d.demasiado) {
        const cuerpo = document.getElementById('cuerpo');
        if (cuerpo) cuerpo.innerHTML = `<div class="vacio">${d.error}<br><br>
          <button class="btn" style="max-width:260px;margin:0 auto"
            onclick="setEst('tipo','on_money')">Ver por dinero</button></div>`;
        return;
      }
      if (!d.ok) return errorEnPantalla(d.error);

      /* 🔴 LAS COLUMNAS TIENEN QUE SER LAS DEL EJE QUE LLEGÓ, no las del que pedimos.
         `profit` y `rtp` existen en los dos ejes, pero `in`/`out` sólo en dinero y `bet`/`win`
         sólo en apuestas. Si se piden las de dinero sobre datos de apuestas, «Cargas» y «Retiros»
         quedan en 0 con una ganancia al lado: ceros que parecen datos.
         Como el eje no se puede cambiar desde acá, se acepta el que manda el casino y se alinea
         todo —columnas, rótulo y botones— con él. */
      if (d.eje) {
        const tipoReal = d.eje === 'apuestas' ? 'on_bets' : 'on_money';
        if (EST_TIPO !== tipoReal) {
          EST_TIPO = tipoReal;
          /* Los datos son los mismos: el motor ignora lo que se le pida. Se guardan también bajo
             la clave nueva para no volver a preguntar. */
          cache.set(`est:${nodo}:${EST_TIPO}:${EST_GRUPO}:${r.from}:${r.to}`, d);
        }
      }
      const destino = ESTADISTICAS[`${EST_TIPO}|${EST_GRUPO}`] || ESTADISTICAS[`${EST_TIPO}|terminal`];
      if (destino) {
        const fila = (f, login) => ({
          login, id: f.id,
          in: plata(f.in), out: plata(f.out), profit: plata(f.profit),
          bet: plata(f.bet), win: plata(f.win),
          rtp: comoRTP(f.rtp),
          count_in: cuantos(f.count_in), count_out: cuantos(f.count_out),
          avg_in: plata(f.avg_in), avg_out: plata(f.avg_out),
          /* 🔴 La columna «Jugadas» del eje de apuestas espera `count`, pero el motor manda
             `count_bet` (apuestas hechas) y `count_win`. Sin este puente la celda decía
             «undefined» — que es peor que un cero, porque no parece un dato faltante sino un
             error. Si el motor no lo manda, se muestra una raya. */
          count: f.count_bet != null ? cuantos(f.count_bet)
               : (f.count != null ? cuantos(f.count) : '—'),
          count_win: f.count_win != null ? cuantos(f.count_win) : '—',
        });
        /* 🔴 «Datos generales» NO es una agrupación del motor: sus opciones son por caja o por
           jugador. Es el TOTAL sin abrir — o sea el `footer`, en una sola fila. Pedirle al motor
           «general» devolvía la lista completa por jugador, con el rótulo diciendo lo contrario. */
        destino.filas = EST_GRUPO === 'general'
          ? (d.total ? [fila(d.total, 'Todo')] : [])
          : (d.filas || []).map((f) => fila(f, f.login));

        /* 🔴 EL EJE LO ELIGE EL PANEL DEL CASINO, NO NOSOTROS. Está guardado como una plantilla
           de la cuenta: `reportstable` la obedece y ningún parámetro la pisa (medido el 27-ago
           replicando el POST del formulario, con sesión y con token — no persiste).
           Así que se muestra lo que el casino MANDÓ y se dice dónde se cambia. Antes la pantalla
           ponía «apostado 0 / ganado 0» y el resultado del otro eje: números inventados. */
        /* El eje de dinero lo arma el backend con los movimientos, así que ese lado del botón
           SIEMPRE se cumple. El de apuestas no: `bet`/`win` sólo existen en el informe del motor,
           y ése obedece a una plantilla que desde acá no se puede cambiar. Se avisa sólo en ese
           caso, y con lo que el cliente puede hacer al respecto. */
        /* Ya no hay eje que elegir. Lo único que queda por avisar es cuando los números no
           salieron del informe sino armados de los movimientos, porque esa cuenta tiene una
           plantilla en apuestas: son exactos igual, pero tardan más y conviene saber por qué. */
        destino.aviso = d.armadoDeMovimientos
          ? 'Tu cuenta está configurada para mostrar <b>apuestas</b>, así que estos números los '
            + 'calculamos con tus movimientos. Son exactos, pero tardan un poco más. '
            + 'Para cambiarlo, escribile a soporte.'
          : null;
        /* ⭐ El RTP de arriba sale del `footer`: es del PERÍODO, no el promedio de la página. */
        if (d.total && d.total.rtp != null) destino.rtp = comoRTP(d.total.rtp);
      }
      estadisticasOriginal.apply(this, arguments);
      soloEjeDinero();
      ajustarAlNodo(nodo);
      /* El rótulo de la app se arma con lo que PEDIMOS. Si el casino mandó otro eje, se aclara
         acá abajo, pegado a ese rótulo, para que no queden dos versiones de la verdad. */
      if (destino.aviso) {
        const ancla = document.querySelector('.filtros-dice');
        if (ancla && !document.getElementById('avisoEje')) {
          const d = document.createElement('div');
          d.id = 'avisoEje';
          d.className = 'nota aviso';
          d.style.margin = '0 0 12px';
          d.innerHTML = destino.aviso;
          ancla.insertAdjacentElement('afterend', d);
        }
      }
      return;
    }
    cargando('Un momento, estamos calculando tus estadísticas');
    pedirUnaVez(clave, () => API.pedir('estadisticas', {
      id: nodo, desde: r.from, hasta: r.to, tipo: EST_TIPO,
      agrupar: EST_GRUPO === 'child_users' ? 'child_users' : 'terminal',
      ordenar: 'profit', limite: 1000,
    }), pintarEstadisticas);
  };

  /* Adentro de una caja: se saca «Por caja» —no aplica— y se dice de quién son los números,
     porque el encabezado sigue mostrando el nombre del agente. */
  function ajustarAlNodo(nodo) {
    if (!DENTRO) return;
    document.querySelectorAll('.tabs button, .chips button').forEach((b) => {
      if ((b.textContent || '').trim() === 'Por caja') b.remove();
    });
    const ancla = document.querySelector('.filtros-dice');
    if (!ancla || document.getElementById('deQuien')) return;
    const caja = (typeof SALAS !== 'undefined' && SALAS.find((s) => String(s.id) === String(nodo))) || null;
    const d = document.createElement('div');
    d.id = 'deQuien';
    d.className = 'nota neutra';
    d.style.margin = '0 0 12px';
    d.innerHTML = `Estos números son de <b class="mono">${caja ? caja.login : nodo}</b>, `
      + 'no de toda tu cuenta. Volvé a «Mis cajeros» para ver el total.';
    ancla.insertAdjacentElement('afterend', d);
  }

  /* 🔴 SÓLO HAY UN EJE: DINERO. Decisión del dueño (28-ago) y la medición la respalda —
     la plantilla por defecto del motor («Default template») es `on_money`, y el informe entrega
     de una sola llamada los siete números que se miran: cargas, retiros, ganancia, cuántas cargas,
     cuántos retiros y los dos promedios. Las apuestas, en cambio, había que pedirlas de a un
     jugador. Se saca el botón y se fuerza el eje. */
  function soloEjeDinero() {
    if (EST_TIPO !== 'on_money') EST_TIPO = 'on_money';
    for (const tabs of document.querySelectorAll('.tabs')) {
      const textos = [...tabs.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
      if (textos.includes('Por dinero') && textos.includes('Por apuestas')) { tabs.remove(); return; }
    }
  }

  /* ══════ 6 · SEGURIDAD — cruces de IP e historial de cambios ══════ */

  /* 🔴 Estas dos NO andan con api_token: el motor las cierra a una credencial sessionless. Si el
     endpoint contesta 409, la sesión del casino se cayó — se dice y se ofrece volver a entrar. */
  function necesitaSesion(d) {
    const cuerpo = document.getElementById('cuerpo');
    if (!cuerpo) return;
    cuerpo.innerHTML = `<div class="vacio">${d.error}<br><br>
      <button class="btn" style="max-width:230px;margin:0 auto" onclick="salir()">Volver a entrar</button></div>`;
  }

  const crucesOriginal = window.pintarCruces;
  window.pintarCruces = function pintarCrucesDeVerdad() {
    if (!window.__caja_sesion) return crucesOriginal.apply(this, arguments);
    const nodo = DENTRO || yoId();
    const r = (() => { try { return rango(IP_PER, 'ip'); } catch (e) { return rangoActual(); } })();
    const clave = `ip:${nodo}:${r.from}:${r.to}`;
    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return d.relogin ? necesitaSesion(d) : errorEnPantalla(d.error);
      /* El motor lo manda como objeto {ip: [{login, datetimes}]}; la app espera una lista. */
      CRUCES.length = 0;
      for (const [ip, gente] of Object.entries(d.cruces || {})) {
        CRUCES.push({ ip, cuentas: (gente || []).map((u) => ({
          login: u.login, hora: (u.datetimes || [])[0] || '', horas: u.datetimes || [],
        })) });
      }
      return crucesOriginal.apply(this, arguments);
    }
    cargando('Un momento, estamos revisando las conexiones');
    pedirUnaVez(clave, () => API.pedir('cruces-ip', { id: nodo, desde: r.from, hasta: r.to }), pintarCruces);
  };

  /* ══════ lo que usan todas ══════ */

  function pedirUnaVez(clave, traer, repintar) {
    if (yaPedido.has(clave)) return;
    yaPedido.add(clave);
    traer().then((d) => { cache.set(clave, d); yaPedido.delete(clave); repintar(); });
  }

  function errorEnPantalla(texto) {
    const cuerpo = document.getElementById('cuerpo');
    if (cuerpo) cuerpo.innerHTML = `<div class="vacio">${texto || 'No se pudo traer la información'}</div>`;
  }

  /* ══════ 7 · SUB-USUARIOS ══════ */

  const subOriginal = window.pintarSub;
  window.pintarSub = function pintarSubDeVerdad() {
    if (!window.__caja_sesion) return subOriginal.apply(this, arguments);
    const nodo = DENTRO || yoId();
    const clave = `sub:${nodo}`;
    if (cache.has(clave)) {
      const d = cache.get(clave);
      if (!d.ok) return d.relogin ? necesitaSesion(d) : errorEnPantalla(d.error);
      const lista = (d.subusuarios || []).map((s) => ({
        id: String(s.id), login: s.login, name: s.name || s.login,
        sala: nodo,
        /* Los permisos no vienen en esta lista: viven en la ficha de cada uno. Hasta que se
           consulten, se muestran como sin restricciones — que es el caso normal. */
        hide_hall_balance: s.hide_hall_balance === true || s.hide_hall_balance === '1',
        disable_statistic: s.disable_statistic === true || s.disable_statistic === '1',
        cajas: {},
      }));
      /* 🔴 Son `const`: no se pueden reasignar, pero sí VACIAR Y LLENAR. El array es el mismo
         objeto, así que la app —que lo lee por referencia— ve los datos nuevos igual. */
      const destino = (esAgente() && !DENTRO) ? SUBAGENTES : SUBCAJEROS;
      destino.length = 0;
      destino.push(...lista);
      const r0 = subOriginal.apply(this, arguments);

      /* 🔴 QUÉ CAJAS VE CADA SUB-AGENTE HAY QUE PREGUNTARLO. La lista del motor no lo trae, así
         que se pide la ficha de cada uno. Son POCOS por naturaleza —un sub-agente es otro acceso
         a tu propia cuenta, no se tienen veinte— y las consultas van EN PARALELO, así que cuesta
         lo que la más lenta, no la suma.
         Se hace después de dibujar: la lista aparece enseguida diciendo «viendo qué cajas
         tiene…» y se completa sola. Si alguna falla, esa queda sin dato y no se inventa. */
      /* 🔴 ACÁ HABÍA UNA CONSULTA POR CADA SUB-AGENTE, PARA PINTAR UN CARTELITO. Se sacó.
         La idea era mostrar en la lista cuántas cajas ve cada uno. El motor no manda ese dato en
         la lista —hay que pedir la ficha de cada uno— y esa consulta extra, con su caché y su
         redibujado, rompió la pantalla tres veces seguidas: primero el cartel se quedaba
         cargando, después mostraba «no ve ninguna» con los permisos bien puestos, y al final
         desapareció un sub-agente de la lista.
         El dato está a un toque de distancia: entrás al sub-agente y ves sus cajas con sus
         llaves. No vale romper la lista de todos para ahorrar ese toque. */
      return r0;
    }
    cargando('Un momento, estamos trayendo tus sub-usuarios', 'lista');
    pedirUnaVez(clave, () => API.pedir('subusuarios', { id: nodo }), pintarSub);
  };

  /* ══════ 8 · lo que TODAVÍA no está conectado, dicho de frente ══════ */

  const PENDIENTES = {};

  const pintarOriginal = window.pintar;
  window.pintar = function pintarConAviso() {
    pintarOriginal.apply(this, arguments);
    const cuerpo = document.getElementById('cuerpo');
    if (!cuerpo) return;
    if (PENDIENTES[SEC]) {
      const aviso = document.createElement('div');
      aviso.className = 'nota';
      aviso.style.cssText = 'background:var(--warn-soft); color:var(--warn); margin-bottom:12px';
      aviso.innerHTML = `<b>Números de ejemplo.</b> ${PENDIENTES[SEC]} todavía no está enchufado
        al casino — el endpoint existe y responde, falta conectar esta pantalla.`;
      cuerpo.insertBefore(aviso, cuerpo.firstChild);
    }
  };

  /* 🔴 El cartel dice lo que REALMENTE se está mostrando. Antes decía «esto es real» con sólo
     haber sesión, y llegó a aparecer sobre datos de ejemplo — que es la peor mentira posible en
     una pantalla de plata. Ahora sale de `ORIGEN`, que lo setea quien trae los datos. */
  const filasOriginal = window.pintarFilas;
  window.pintarFilas = function pintarFilasConNota() {
    filasOriginal.apply(this, arguments);
    const lista = document.getElementById('lista');
    if (!lista || !window.__caja_sesion) return;
    /* 🔴 `pintarFilas` corre en CADA tecla del buscador. Sin esto se apilaba un cartel por
       pulsación: escribir «ganamos» dejaba siete carteles iguales debajo de la lista. */
    const previo = document.getElementById('cartelOrigen');
    if (previo) previo.remove();
    /* 🔴 CUANDO EL DATO ES REAL NO SE DICE NADA. Era útil mientras media aplicación era maqueta:
       había que poder distinguir de un vistazo qué venía del casino y qué no. Ahora que todo
       viene del casino, ese cartel verde aparecía en TODAS las pantallas anunciando lo normal, y
       un aviso que sale siempre deja de leerse — con lo cual también se deja de ver el día que
       diga otra cosa.
       Los otros dos SÍ se quedan: «no se pudo traer» y «números de ejemplo» avisan que algo anda
       mal o que lo que mirás no es tuyo, y eso hay que decirlo siempre. */
    if (ORIGEN === 'servidor') return;

    const nota = document.createElement('div');
    nota.id = 'cartelOrigen';
    nota.className = 'nota';
    if (ORIGEN === 'error') {
      nota.style.cssText = 'background:var(--no-soft); color:var(--no); margin-top:10px';
      nota.innerHTML = `<b>No se pudo traer del casino.</b> ${ultimoError || ''}`;
    } else {
      nota.style.cssText = 'background:var(--warn-soft); color:var(--warn); margin-top:10px';
      nota.innerHTML = '<b>Números de ejemplo.</b> Esta lista todavía no vino del casino.';
    }
    lista.parentElement.insertBefore(nota, lista.nextSibling);
  };

  /* ══════ 5 · el selector de rol del prototipo no va en la app ══════ */
  document.addEventListener('DOMContentLoaded', () => {
    const demo = document.querySelector('.demo');
    if (demo) demo.remove();
    const aviso = document.querySelector('.aviso');
    /* 🔴 EL CARTEL TIENE QUE DECIR ALGO CIERTO. Decía que algunas pantallas mostraban ejemplos;
       revisadas las nueve el 2-sep-2026, todas traen datos del casino. Dejarlo así le restaba
       confianza a números que son reales. Ahora dice para qué sirve el cartel. */
    if (aviso) aviso.innerHTML = '<b>En pruebas</b> · si algo falla, pasá el número de caso que sale en el error';
  });

  window.__cajaAPI = API;
})();
