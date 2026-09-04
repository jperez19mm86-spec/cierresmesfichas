/* ══════ LA LÓGICA DE LA PANTALLA, SIN PANTALLA ══════

   Acá vive lo que la pantalla PIENSA, separado de lo que la pantalla DIBUJA. Nada de esto toca el
   documento: son cuentas y decisiones sobre datos que entran y salen.

   Está afuera de `caja.html` por un motivo concreto: metido adentro de una función que dibuja, no
   se puede probar sin un navegador, y los errores más caros de esta pantalla fueron justamente de
   este tipo —un número mal leído, una fecha mal comparada—. Ahora los cubre `test/caja-pantalla.js`,
   que corre en segundos y no necesita navegador ni casino.

   Se carga como script normal antes del principal, así que estas funciones quedan disponibles para
   todo el panel igual que antes. El `module.exports` del final es sólo para los tests.            */

/* ── PLATA ──────────────────────────────────────────────────────────────────────────────────────
   🔴 EL ERROR QUE OFRECÍA CARGAR DIEZ VECES DE MÁS. Se limpiaban los símbolos junto con la coma
   decimal: la caja tenía 7.028,6 y el formulario ofrecía 70.286. Con dos decimales habría sido
   cien veces. Formato argentino: el punto separa miles, la coma es el decimal. */
function aNumero(txt) {
  const limpio = String(txt == null ? '' : txt)
    .replace(/[^\d.,-]/g, '')   // fuera letras, símbolos y espacios
    .replace(/\./g, '')          // los puntos son separador de miles
    .replace(',', '.');          // la coma es el decimal
  const n = Number(limpio);
  return Number.isFinite(n) ? n : 0;
}

/* ── LOGINS ─────────────────────────────────────────────────────────────────────────────────────
   El motor deja crear logins con espacios y símbolos, pero después esas cuentas dan error. Lo que
   no es letra o número no entra: antes se aceptaba «s8788» y por dentro se leía 8788 — el campo
   mostraba una cosa y el sistema entendía otra. */
function limpiarTextoLogin(crudo) {
  return String(crudo == null ? '' : crudo).replace(/[^A-Za-z0-9]/g, '');
}

/* El nombre y el login son «el mismo» si sólo se diferencian en espacios, puntos o mayúsculas.
   Sirve para no repetir dos veces lo mismo en pantalla. */
function mismoNombre(nombre, login) {
  const limpio = (t) => String(t || '').replace(/[\s._-]+/g, '').toLowerCase();
  return !nombre || limpio(nombre) === limpio(login);
}

/* ── CRUCES DE IP ───────────────────────────────────────────────────────────────────────────────
   🔴 SE MIRAN TODAS LAS VISITAS, NO LA PRIMERA. Antes se filtraba por la primera vez que una
   cuenta entró desde esa IP. Una cuenta que venía entrando desde hacía semanas quedaba descartada
   aunque hubiera entrado hoy, y al quedar una sola adentro el cruce entero desaparecía: la pantalla
   decía «0 IPs compartidas» con dos cuentas conectadas hoy desde la misma dirección. Fallaba justo
   con las cuentas viejas, que son las que importa mirar. Reproducido el 1-sep-2026. */
function crucesEnRango(cruces, rango) {
  const desde = rango && rango.from;
  const hasta = rango && rango.to;
  const dentro = (h) => { const d = String(h || '').slice(0, 10); return d >= desde && d <= hasta; };
  return (cruces || [])
    .map((c) => ({ ...c, cuentas: (c.cuentas || []).reduce((quedan, u) => {
      const visitas = (u.horas && u.horas.length ? u.horas : [u.hora]).filter(dentro);
      if (visitas.length) quedan.push({ ...u, hora: visitas[0], horas: visitas });
      return quedan;
    }, []) }))
    .filter((c) => c.cuentas.length > 1);   // una sola cuenta no es un cruce
}

/* ── MOVIMIENTOS DE CUENTAS QUE YA NO ESTÁN ─────────────────────────────────────────────────────
   Señalado el 4-sep-2026: al eliminar una caja, sus movimientos siguen en la lista con su login y
   nada avisa que esa cuenta ya no existe. Y TIENEN que seguir — el historial es historial, no
   desaparece porque alguien haya borrado la cuenta; si desapareciera, la plata de esos días no
   cuadraría con nada. Lo que faltaba no era esconderlos: era decirlo.

   🔴 EL MOTOR NO LO DICE. La fila de `area=balance` trae `user` y `uid` y NINGÚN campo de borrado
   —comprobado el 4-sep sobre 29 movimientos reales—. El cruce se hace acá, por `uid`, contra la
   lista de eliminadas QUE YA ESTÉ CARGADA: la trae la pantalla de Cuentas, así que normalmente
   está. Nunca se pide de más. Y si no la tenemos, no se afirma nada — el aviso pasa a decir «puede
   incluir». Medido ese mismo día: 4 de 29 movimientos eran de dos cajas de prueba ya borradas, y
   la pantalla las mostraba como si siguieran vivas.

   🔴 NO SE NOMBRAN, A PROPÓSITO. La primera versión listaba los logins arriba. Con volumen no
   sirve: medido con 20.000 movimientos, salieron 600 cuentas eliminadas distintas — «CajA, CajB,
   CajC y 597 más» no es información, es relleno, y encima suena a total cuando el motor corta la
   lista en 1.000 filas. Lo que sirve es la marca en la fila, que está donde mirás. Por eso esto
   devuelve un Set de ids y nada más: es lo único que la pantalla necesita, y evita armar una
   lista de nombres que nadie va a leer. El cruce completo cuesta 3,5 ms con 20.000 filas. */
function eliminadasDeLaLista(filas, borrados, nodo) {
  const ids = new Set((borrados || [])
    .filter((b) => nodo == null || String(b.sala) === String(nodo))
    .map((b) => String(b.id)));
  const halladas = new Set();
  for (const m of filas || []) {
    const uid = String((m && m.uid) == null ? '' : m.uid);
    if (ids.has(uid)) halladas.add(uid);
  }
  return halladas;
}

/* ── EL MENÚ DE CADA NIVEL ──────────────────────────────────────────────────────────────────────
   🔴 NO SALE DEL MOTOR, Y NO PUEDE. `area=buttons` miente para los dos lados, medido el
   1-sep-2026: al cajero no le nombra el Resumen y el Resumen le funciona; al sub-agente sí le
   nombra Movimientos y Movimientos le contesta «No rights». Así que la lista es ésta, y la pantalla
   la corrige sola cuando el motor dice que no.

   🔑 `reports` e `intersections` no van en la barra (decisión del dueño, 27-ago): un botón fijo
   invita a entrar todos los días a pantallas caras. Se llega desde donde tiene sentido. */
const MENU_POR_NIVEL = {
  agente: ['users', 'dashboard', 'balance', 'sub'],
  /* El cajero no tiene sección de sub-usuarios: sus sub-cajeros salen de la ficha de la caja. */
  cajero: ['users', 'dashboard', 'balance'],
  /* 🔴 EL SUB-CAJERO SÍ TIENE RESUMEN. Un sub-cajero ve TODO lo de su caja —así está construido,
     no filtra nada— y se comprobó el 2-sep-2026: lista exactamente los mismos 5 jugadores que ve
     el agente. El «8» que decía el Resumen y no cerraba con esa lista no era un problema suyo:
     ese número cuenta también las cuentas eliminadas (5 activas + 3 borradas = 8), y eso pasa en
     todos los niveles. Se arregló ahí, que es donde estaba. */
  subcajero: ['users', 'dashboard', 'balance'],
  /* 🔴 EL SUB-AGENTE NO TIENE RESUMEN. El motor le niega Movimientos, y el Resumen se lo contesta
     TODO EN CERO —medido el 2-sep-2026: el agente ve 13 jugadores y él 0, en su propio nodo y en
     la caja que sí tiene habilitada—. Llegamos a calcularlo sumando sus cajas, pero costaba una
     consulta más por cada visita a una pantalla que el casino no sostiene. Decisión del dueño:
     si el casino no lo da, no se arma. Le queda su lista de cajeros, que es lo que usa. */
  subagente: ['users'],
};

/* 🔴 EL PERMISO «SIN ESTADÍSTICAS» LO HACE CUMPLIR ESTA PANTALLA, PORQUE EL MOTOR NO.
   Medido el 2-sep-2026: con el permiso encendido en el casino, el motor le devuelve los números
   igual. Es una intención del dueño, y si el panel no la respeta no la respeta nadie. */
function seccionesDe(rol, esSubAgente) {
  return (MENU_POR_NIVEL[esSubAgente ? 'subagente' : rol] || MENU_POR_NIVEL.cajero).slice();
}

/* Si el dueño le apagó las estadísticas a un sub-cajero, no le queda ninguna puerta para llegar. */
function puedeVerNumeros(rol, permisos) {
  if (rol !== 'subcajero') return true;
  return !(permisos && permisos.disable_statistic === true);
}

/* El grupo que da el motor decide el nivel. El 6 navega como agente pero con menú más corto. */
function nivelDeGrupo(grupo) {
  const porGrupo = { 3: 'agente', 4: 'cajero', 6: 'agente', 8: 'subcajero' };
  const g = Number(grupo);
  return { rol: porGrupo[g] || 'cajero', subagente: g === 6 };
}

/* ── LO QUE EL MOTOR NIEGA ──────────────────────────────────────────────────────────────────────
   Sólo un «no» explícito saca una pestaña. Un error de red no saca nada: si se corta la conexión,
   la sección sigue estando. */
const SECCION_DE_RUTA = {
  cuentas: 'users', resumen: 'dashboard', movimientos: 'balance',
  estadisticas: 'reports', subusuarios: 'sub', 'cruces-ip': 'intersections',
};

function seccionNegadaPor(ruta, error) {
  const sec = SECCION_DE_RUTA[ruta];
  if (!sec) return null;
  return /no rights|sub users disabled|access denied|not allowed/i.test(String(error || '')) ? sec : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    aNumero, limpiarTextoLogin, mismoNombre, crucesEnRango, eliminadasDeLaLista,
    MENU_POR_NIVEL, seccionesDe, puedeVerNumeros, nivelDeGrupo, seccionNegadaPor,
  };
}
