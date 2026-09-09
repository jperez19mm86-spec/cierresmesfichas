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
  const crudo = String(txt == null ? '' : txt).replace(/[^\d.,-]/g, '');
  /* 🔴 EL MOTOR TAMBIÉN ESCRIBE EN FORMATO INGLÉS. Medido el 8-sep-2026: una apuesta deportiva
     devolvió el saldo como «4,671.10». Con la regla argentina —punto = miles, coma = decimal— eso
     se leía 4,67: casi mil veces menos, y en la misma pantalla donde se decide cuánto cargar.
     Cuando vienen LOS DOS separadores, el último es el decimal, sea cual sea. Con uno solo se
     mantiene la regla de acá, porque «1.234» tecleado por un cajero son mil doscientos treinta y
     cuatro, no uno con coma dos tres cuatro. */
  const ultimaComa = crudo.lastIndexOf(',');
  const ultimoPunto = crudo.lastIndexOf('.');
  let limpio;
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    const decimal = ultimaComa > ultimoPunto ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    limpio = crudo.split(miles).join('').replace(decimal, '.');
  } else if ((crudo.match(/,/g) || []).length > 1) {
    /* Una coma repetida sin puntos sólo puede ser separador de miles: «1,200,000». */
    limpio = crudo.split(',').join('');
  } else {
    limpio = crudo.replace(/\./g, '').replace(',', '.');
  }
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

/* ── LA TIRA DE PERÍODOS ─────────────────────────────────────────────────────────────────────────
   🔴 EL BOTÓN ELEGIDO PODÍA QUEDAR FUERA DE PANTALLA. La tira se desplaza de costado y
   «Otro rango…» es el último de seis: en un teléfono no entra. O sea que justo el botón que LLEVA
   LAS FECHAS elegidas era el que no se veía, y la tira parecía no tener nada marcado. Pedido el
   4-sep-2026: «el filtro de fecha debería ser más visible cuando se selecciona otro rango».

   Devuelve a cuánto hay que desplazar la tira, o `null` si el botón ya está a la vista — que es la
   mitad del asunto: si no hace falta no se mueve nada, para no pelearle al dedo de quien la está
   desplazando. */
function desplazarHastaElegido(boton, tira) {
  if (!boton || !tira || !tira.ancho) return null;
  const fin = boton.izq + boton.ancho;
  const yaSeVe = boton.izq >= tira.scroll && fin <= tira.scroll + tira.ancho;
  if (yaSeVe) return null;
  /* Centrado cuando entra; pegado al borde cuando el botón es más ancho que la tira. */
  const centrado = boton.izq - (tira.ancho - boton.ancho) / 2;
  const tope = Math.max(0, tira.total - tira.ancho);
  return Math.max(0, Math.min(Math.round(centrado), tope));
}

/* ── LA MATRIZ DE UNA RONDA ──────────────────────────────────────────────────────────────────────
   🔴 `elements` VIENE [COLUMNA, FILA] Y EMPIEZA EN 1. No está documentado en ningún lado: se
   comprobó contra la grilla el 4-sep-2026. La línea ganadora decía símbolo 6, 7 celdas, y las
   siete posiciones —(5,4) (5,5) (6,5) (7,5) (7,4) (6,6) (5,6)— caen exactamente sobre un 6 leyendo
   [columna, fila] con base 1. Leído al revés, o con base 0, marcaría celdas equivocadas y la
   pantalla mostraría un premio pintado donde no está. */
/* 🔴 CADA SELLO MANDA ESTO A SU MANERA. Medido el 8-sep-2026 jugando una ronda con cada uno y
   comparando las respuestas crudas:

     sello            símbolos              líneas         celdas
     SL  · EGT        números               `winLines`     [a,b]
     SL2 · 3OAKS      OBJETOS y números     claves `s c w e`  [a,b]
     XG  · RUBYPLAY   textos «5»            `win_lines`    [a,b,bandera]
     XG  · AINSWORTH  textos «Ae»           OBJETO indexado [a,b,bandera]
     SZ / OP          no mandan grilla      —              —

   Dos de esas formas rompían la pantalla: un símbolo que es objeto se dibujaba «[object Object]»,
   y una lista de líneas que es objeto no se podía recorrer. */

function simboloDeCelda(c) {
  if (c && typeof c === 'object') return String(c.image != null ? c.image : (c.value != null ? c.value : '?'));
  return String(c == null ? '' : c);
}

/* 3OAKS manda algunas celdas como `{image:'10', value:30}`: el `value` es el multiplicador de esa
   posición, y es justo el dato que explica un pago grande. */
function multiplicadorDeCelda(c) {
  return (c && typeof c === 'object' && c.value != null) ? c.value : null;
}

/* Las líneas llegan como lista o como objeto indexado, y con nombres largos o cortos. */
function normalizarLineas(w) {
  const lista = Array.isArray(w) ? w : (w && typeof w === 'object' ? Object.values(w) : []);
  return lista.filter(Boolean).map((l) => ({
    simbolo: simboloDeCelda(l.symbol != null ? l.symbol : l.s),
    cuantos: l.count != null ? l.count : l.c,
    pago: Number(l.cash != null ? l.cash : l.w) || 0,
    linea: l.line != null ? l.line : null,
    xWin: l.xWin != null ? l.xWin : null,
    celdas: Array.isArray(l.elements) ? l.elements : (Array.isArray(l.e) ? l.e : []),
  }));
}

/* 🔴 SÓLO SE PINTA LO QUE SE PUEDE PROBAR. Las coordenadas vienen en cuatro formas —[columna,fila]
   o [fila,columna], empezando en 0 o en 1— y ni siquiera son iguales dentro del mismo proveedor:
   un RUBYPLAY medido el 4-sep venía en base 1 y otro el 8-sep en base 0. Adivinar mal significa
   pintar el premio en una celda que no pagó, que es peor que no pintar nada.
   Así que se prueban las cuatro lecturas y se elige la que hace coincidir MÁS celdas con el
   símbolo que pagó; sólo se marcan las que de verdad lo contienen. Si ninguna coincide —pasa con
   EGT, y con los comodines que completan una línea sin ser el símbolo— no se marca nada y queda
   el resumen, que sale del motor y no se interpreta. */
const LECTURAS = [
  { nombre: 'col,fila base 0', fila: (e) => e[1], col: (e) => e[0] },
  { nombre: 'col,fila base 1', fila: (e) => e[1] - 1, col: (e) => e[0] - 1 },
  { nombre: 'fila,col base 0', fila: (e) => e[0], col: (e) => e[1] },
  { nombre: 'fila,col base 1', fila: (e) => e[0] - 1, col: (e) => e[1] - 1 },
];

function celdasGanadoras(lineas, matriz) {
  const normal = Array.isArray(lineas) && lineas.length && lineas[0].celdas
    ? lineas : normalizarLineas(lineas);
  if (!matriz || !matriz.length || !normal.length) return new Set();

  let mejor = new Set();
  for (const lectura of LECTURAS) {
    const marcadas = new Set();
    for (const l of normal) {
      for (const e of l.celdas) {
        if (!Array.isArray(e) || e.length < 2) continue;
        /* El tercer número de RUBYPLAY y AINSWORTH es una bandera: 0 = esa celda no entró. */
        if (e.length > 2 && Number(e[2]) === 0) continue;
        const f = lectura.fila(e);
        const c = lectura.col(e);
        const celda = matriz[f] && matriz[f][c];
        if (celda === undefined) continue;
        if (simboloDeCelda(celda) === l.simbolo) marcadas.add(`${f}:${c}`);
      }
    }
    if (marcadas.size > mejor.size) mejor = marcadas;
  }
  return mejor;
}

/* `fila` y `columna` en base 0, que es como se recorre la grilla al dibujarla. */
function esCeldaGanadora(marcadas, fila, columna) {
  return !!marcadas && marcadas.has(`${fila}:${columna}`);
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
    desplazarHastaElegido, celdasGanadoras, esCeldaGanadora,
    simboloDeCelda, multiplicadorDeCelda, normalizarLineas,
    MENU_POR_NIVEL, seccionesDe, puedeVerNumeros, nivelDeGrupo, seccionNegadaPor,
  };
}
